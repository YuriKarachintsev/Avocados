import { mountChrome } from './ui.js';

mountChrome(location.pathname === '/privacy' ? '/profile' : '/');
