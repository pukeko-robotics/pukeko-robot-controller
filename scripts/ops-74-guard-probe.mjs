// OPS-74 acceptance probe. A deliberately planted bare-name spawn, of exactly the
// kind the QA-19 guard in check-no-bare-launchers.mjs exists to catch: a one-shot
// runner name resolved against the public registry and executed. The guard must
// fail on this file, which is the proof that the new push and pull_request
// triggers make it binding rather than advisory.
//
// Nothing imports or runs this. It exists only on a throwaway scratch branch and
// is deleted along with it.
import { spawn } from 'node:child_process'

spawn('npx', ['some-tool-name'], { stdio: 'inherit' })
