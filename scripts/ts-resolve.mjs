/** Registers `ts-extension-hook.mjs`. See that file for why it exists. */
import { register } from 'node:module';

register('./ts-extension-hook.mjs', import.meta.url);
