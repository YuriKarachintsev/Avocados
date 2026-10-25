// In-memory AI job queue. Photos live only in memory for the life of a job:
// the uploaded copy on Replicate is deleted as soon as the prediction ends,
// and results are dropped once downloaded or after AI_JOB_TTL_MS.
import { HttpError, randomId } from './http-utils.js';
import { editPrompt, BACKGROUND_PRESETS, ASPECTS } from './ai-presets.js';

export class AiJobs {
  constructor(cfg, client, log = () => {}) {
    this.cfg = cfg;
    this.client = client;
    this.log = log;
    this.jobs = new Map();
    this.queue = [];
    this.active = 0;
    this.spend = { day: utcDay(), usd: 0 };
  }

  budgetLeft() {
    if (this.spend.day !== utcDay()) this.spend = { day: utcDay(), usd: 0 };
    return this.cfg.limits.dailyBudgetUsd - this.spend.usd;
  }

  costOf(feature) {
    if (feature === 'matte') return this.cfg.costs.matte;
    if (feature === 'background') return this.cfg.costs.background;
    return this.cfg.costs.edit;
  }

  create({ sid, feature, preset, image, imageType, aspect }) {
    if (feature === 'background') {
      if (!BACKGROUND_PRESETS[preset]) throw new HttpError(400, 'bad_preset', 'Unknown background style.');
      if (!ASPECTS.has(aspect)) aspect = '3:4';
    } else if (feature === 'matte') {
      if (!image) throw new HttpError(400, 'no_image', 'No photo was received.');
    } else {
      if (!editPrompt(feature, preset)) throw new HttpError(400, 'bad_preset', 'Unknown style.');
      if (!image) throw new HttpError(400, 'no_image', 'No photo was received.');
    }
    for (const j of this.jobs.values()) {
      if (j.sid === sid && !isDone(j)) {
        throw new HttpError(409, 'busy', 'Another AI edit is still running. Wait for it to finish or cancel it.');
      }
    }
    const cost = this.costOf(feature);
    if (this.budgetLeft() < cost) {
      throw new HttpError(503, 'daily_limit', "Today's AI editing limit has been reached. On-device tools still work; AI tools reset at midnight UTC.");
    }
    this.spend.usd += cost; // reserved; refunded if the job fails before reaching the model

    const job = {
      id: randomId(18), sid, feature, preset, aspect, image, imageType,
      status: 'queued', stage: 'Waiting for a free slot', createdAt: Date.now(), updatedAt: Date.now(),
      controller: new AbortController(), result: null, error: null, cost, charged: false, fileId: null,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  pump() {
    while (this.active < this.cfg.limits.maxConcurrentJobs && this.queue.length) {
      const job = this.queue.shift();
      if (isDone(job)) continue;
      this.active++;
      this.runJob(job).finally(() => { this.active--; this.pump(); });
    }
  }

  async runJob(job) {
    const { client, cfg } = this;
    const signal = job.controller.signal;
    const set = (status, stage) => { job.status = status; job.stage = stage; job.updatedAt = Date.now(); };
    try {
      let input;
      let model;
      let community = false;
      if (job.feature === 'background') {
        model = cfg.replicate.backgroundModel;
        input = { prompt: BACKGROUND_PRESETS[job.preset].prompt, aspect_ratio: job.aspect, safety_tolerance: 2, output_format: 'png' };
      } else {
        set('uploading', 'Sending your photo securely');
        const imageRef = await this.stageImage(job, signal);
        if (job.feature === 'matte') {
          model = cfg.replicate.matteModel;
          community = !model.startsWith('black-forest-labs/');
          input = { image: imageRef, variant: cfg.replicate.matteVariant, output_format: 'mask' };
        } else {
          model = cfg.replicate.editModel;
          input = {
            prompt: editPrompt(job.feature, job.preset), input_image: imageRef,
            aspect_ratio: 'match_input_image', output_format: 'png', safety_tolerance: 2,
          };
        }
      }
      set('processing', 'AI is working on your photo');
      const { url } = await client.run(model, input, {
        signal, community,
        onStatus: (s) => { job.charged = true; if (s === 'starting') set('processing', 'Starting the AI model'); else if (s === 'processing') set('processing', 'AI is working on your photo'); },
      });
      job.charged = true;
      await this.releaseFile(job);
      set('finalizing', 'Fetching the result');
      const out = await client.download(url, { signal });
      job.result = out;
      job.image = null;
      set('succeeded', 'Done');
    } catch (err) {
      await this.releaseFile(job);
      job.image = null;
      if (!job.charged) this.spend.usd = Math.max(0, this.spend.usd - job.cost);
      if (signal.aborted) {
        set('canceled', 'Canceled');
      } else {
        job.error = err instanceof HttpError ? { code: err.code, message: err.message }
          : { code: 'provider_error', message: 'The AI service is unavailable right now. Please try again shortly.' };
        if (err instanceof HttpError && err.detail) this.log(`replicate error ${err.code}: ${err.detail}`);
        else if (!(err instanceof HttpError)) this.log(`job error: ${err?.message || err}`);
        set('failed', 'Failed');
      }
    }
  }

  async stageImage(job, signal) {
    const buf = job.image;
    if (buf.length <= 256 * 1024) {
      return `data:${job.imageType};base64,${buf.toString('base64')}`;
    }
    const ext = job.imageType === 'image/png' ? 'png' : job.imageType === 'image/webp' ? 'webp' : 'jpg';
    const file = await this.client.uploadFile(buf, job.imageType, `photo.${ext}`, signal);
    job.fileId = file.id;
    return file.url;
  }

  async releaseFile(job) {
    if (job.fileId) {
      const id = job.fileId;
      job.fileId = null;
      await this.client.deleteFile(id);
    }
  }

  get(sid, id) {
    const job = this.jobs.get(id);
    if (!job || job.sid !== sid) throw new HttpError(404, 'not_found', 'That edit has expired. Please run it again.');
    return job;
  }

  takeResult(sid, id) {
    const job = this.get(sid, id);
    if (job.status !== 'succeeded' || !job.result) throw new HttpError(409, 'not_ready', 'The result is not ready yet.');
    const result = job.result;
    this.jobs.delete(id);
    return result;
  }

  cancel(sid, id) {
    const job = this.get(sid, id);
    if (!isDone(job)) job.controller.abort(new Error('canceled by user'));
    job.result = null;
    job.image = null;
    this.jobs.delete(id);
  }

  purgeSession(sid) {
    let n = 0;
    for (const [id, job] of this.jobs) {
      if (job.sid !== sid) continue;
      if (!isDone(job)) job.controller.abort(new Error('session deleted'));
      job.result = null;
      job.image = null;
      this.jobs.delete(id);
      n++;
    }
    return n;
  }

  sweep(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      if (now - job.createdAt > this.cfg.limits.jobTtlMs) {
        if (!isDone(job)) job.controller.abort(new Error('expired'));
        job.result = null;
        job.image = null;
        this.jobs.delete(id);
      }
    }
  }

  publicView(job) {
    return { id: job.id, feature: job.feature, status: job.status, stage: job.stage, error: job.error };
  }
}

function isDone(job) {
  return ['succeeded', 'failed', 'canceled'].includes(job.status);
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}
