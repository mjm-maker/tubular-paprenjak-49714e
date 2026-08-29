/** Upload-only music and volume checks — `npm run music:check`. */

import {
  describeMusicFileProblem,
  musicCoverage,
  normaliseVolume,
} from '../lib/music.ts';
import { effectiveMusicLevel } from '../lib/mix.ts';

let checks = 0;
let failures = 0;

function ok(condition, label) {
  checks++;
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}

console.log('GLASKO upload-only music checks');

ok(normaliseVolume(-0.2) === 0, 'volume never falls below 0%');
ok(normaliseVolume(1.4) === 1, 'volume never rises above 100%');
ok(normaliseVolume(0.37) === 0.37, 'every normal slider step is preserved');
ok(normaliseVolume(Number.NaN) === 0, 'invalid volume input fails safely');

ok(
  effectiveMusicLevel(0.85, 0.2) === 0.85,
  'the entire music slider changes the real level without a hidden ceiling',
);
ok(effectiveMusicLevel(0, 1) === 0, '0% music is silent');

ok(
  describeMusicFileProblem({ name: 'my-song.mp3', type: 'audio/mpeg', size: 1024 }) === null,
  'a normal uploaded song is accepted',
);
ok(
  Boolean(describeMusicFileProblem({ name: 'movie.mov', type: 'video/quicktime', size: 1024 })),
  'a non-music upload is rejected',
);

ok(musicCoverage(20, 45).mode === 'loop', 'a short song loops under a longer voice');
ok(musicCoverage(90, 30).mode === 'trim', 'a long song trims to the voice');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
