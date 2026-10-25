# Deploy CAREer Studio on Render (about 20 minutes)

You need: a GitHub account, a Render account, a Replicate account with billing, a Telegram account,
and your domain (e.g. careerstudioapp.com) at any registrar. Keys are typed only into Render's
dashboard — never into chat or the code.

## 1. Get your keys
1. **Replicate** — replicate.com ▸ sign in ▸ Billing: add a card and set a monthly spend limit ▸
   Account ▸ API tokens ▸ create a token. Keep it for step 3.
2. **Telegram bot** — in Telegram open **@BotFather** ▸ `/newbot` ▸ choose a name ▸ copy the token.
   Send your new bot one message (or add it to your team group and post there).
3. **Telegram chat ID** — on your computer, in this folder: put the token in a `.env` file as
   `TELEGRAM_BOT_TOKEN=...`, run `npm run telegram:chat-id`, and copy the `TELEGRAM_CHAT_ID` it prints.

## 2. Put the code on GitHub
1. github.com ▸ New repository ▸ name `careerstudio` ▸ Private ▸ Create.
2. On the empty repo page choose **uploading an existing file**, drag in everything inside the
   `careerstudio` folder (not the `.env` file), and Commit.

## 3. Create the service on Render
1. dashboard.render.com ▸ **New ▸ Blueprint** ▸ connect GitHub ▸ pick `careerstudio`.
   Render reads `render.yaml` and proposes one web service on the Starter plan.
2. Fill in the secret values it asks for: `REPLICATE_API_TOKEN`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`, and optionally `CONTACT_EMAIL`. ▸ **Apply**.
3. Wait for "Live". Open the `…onrender.com` address it shows.

## 4. Connect the domain
1. In the service ▸ Settings ▸ Custom Domains ▸ add `careerstudioapp.com` and `www.careerstudioapp.com`.
2. At your registrar, create the DNS records Render displays. Certificates are issued automatically.
3. If you use a different domain, change `PUBLIC_ORIGIN` and `ALLOWED_ORIGINS` in the service's
   Environment settings to match, then redeploy.

## 5. First-run checks (5 minutes, on your phone)
1. `/profile` ▸ Service status: AI editing and Contact form say **Available**.
2. Editor ▸ open a selfie ▸ Outfit ▸ any look ▸ agree ▸ result within ~30 s ▸ Apply ▸ hold Compare.
3. Hair ▸ Keratin ▸ Apply. Background ▸ HD · AI ▸ Classic grey ▸ check the hair edges.
4. Background ▸ an AI modern office (wand tile) ▸ a photorealistic office appears.
5. Passport ▸ your country ▸ Create ▸ read the checks ▸ Download photo and Print sheet.
6. Profile ▸ send a test enquiry; then one with a photo and the photo box ticked → both arrive in Telegram.
7. Replicate dashboard ▸ Predictions shows each call; the Files list stays empty after edits finish.

Any failure: Render ▸ Logs shows the provider's error message (never photos or personal data).
