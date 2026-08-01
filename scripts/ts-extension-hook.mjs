/**
 * Lets `node` load the app's TypeScript modules by their extensionless import paths.
 *
 * Node strips types out of a `.ts` file happily enough, but it will not guess the
 * extension the way a bundler does, and `lib/*.ts` imports its neighbours the way
 * Next.js expects — `from './subtitles'`. Rather than write those imports for the sake
 * of a check script, this resolver retries a failed specifier with `.ts` on the end.
 *
 * Used only by `scripts/check-subtitle-sync.mjs`. Nothing shipped depends on it.
 */

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!relative || specifier.endsWith('.ts')) throw error;
    return next(`${specifier}.ts`, context);
  }
}
