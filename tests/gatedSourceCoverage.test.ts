import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import ts from 'typescript';

/**
 * OPS-75 — every tracked source file must be reached by a gate that parses it.
 *
 * `pnpm run type-check` exits 0 for a file no project enumerates: `vue-tsc --build` walks
 * the projects listed in `tsconfig.json`, and a file outside all of their `include` globs
 * is never opened. A green type-check is therefore not evidence that a file is checked —
 * it is only evidence that the files which happen to be checked are clean. Four tracked
 * files sat outside every project this way (the e2e harness, the Playwright config and its
 * spec, the example config), so a syntax error, a broken relative path or a renamed export
 * in any of them survived every gate and surfaced the next time a human ran the file.
 * This spec is what reads the denominator: it asks TypeScript, per project, which files it
 * would enumerate, and fails naming any tracked source file that gets picked up by none.
 *
 * **"Root file of a project" is a PROXY for "parsed by a gate", and the proxy has a known
 * blind spot.** It sees which files a project enumerates, not whether that project is
 * actually type-checked in `--build` mode. A project that is listed in `references` but
 * silently skipped would still look covered here. That gap is closed by evidence outside
 * this spec: OPS-75 drove a deliberate error through each of the four files and read
 * `pnpm run type-check` go red for every one. If you add a project, do the same for it —
 * this spec cannot make that check for you.
 *
 * The file list comes from `git ls-files`, so this covers every tracked file and build
 * output can never trip it. Paths are compared repo-relative with forward slashes, so a
 * failure reads identically on Windows.
 */

/**
 * Vitest runs with its config's directory as cwd, which is the repo root. Under the jsdom
 * environment `import.meta.url` is not a `file:` URL, so it cannot be used here. The
 * `existsSync` guard makes a wrong root fail immediately and by name, rather than silently
 * yielding an empty file list that every assertion below would pass by scanning nothing.
 */
const REPO_ROOT = `${process.cwd().replace(/\\/g, '/').replace(/\/$/, '')}/`;
if (!existsSync(`${REPO_ROOT}tsconfig.json`)) {
  throw new Error(`OPS-75 coverage spec: ${REPO_ROOT} is not the repo root (no tsconfig.json)`);
}

/** Extensions a project could parse. `.vue` is included — `vue-tsc` compiles those too. */
const SOURCE_EXTENSION = /\.(?:m|c)?[jt]sx?$|\.vue$/;

/**
 * `.vue` is not one of TypeScript's own extensions, so `parseJsonConfigFileContent` drops
 * every SFC from `src/**` unless it is told about them — which would land all nine in the
 * offender list and make this spec fail for a reason that has nothing to do with coverage.
 * `Deferred` is the script kind `vue-tsc` itself uses for them.
 */
const EXTRA_EXTENSIONS: readonly ts.FileExtensionInfo[] = [
  { extension: '.vue', isMixedContent: false, scriptKind: ts.ScriptKind.Deferred },
];

/** The four files OPS-75 brought into a gate, asserted by name so a regression is loud. */
const FORMERLY_UNGATED = [
  'it-robot.js',
  'playwright.config.ts',
  'pukeko.config.example.ts',
  'e2e/robot.spec.ts',
] as const;

/** Ordinary application source. A reader can check by eye that this must be covered. */
const OBVIOUSLY_COVERED = 'src/main.ts';

function toRepoRelative(absolute: string): string {
  return absolute.replace(/\\/g, '/').replace(REPO_ROOT.replace(/\\/g, '/'), '');
}

/** The files a single tsconfig enumerates as roots, repo-relative. */
function rootFilesOf(configPath: string): string[] {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error, `could not read ${configPath}`).toBeUndefined();

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    REPO_ROOT,
    /* existingOptions */ undefined,
    configPath,
    /* resolutionStack */ undefined,
    EXTRA_EXTENSIONS
  );
  // `errors` also carries benign informational diagnostics; only a hard failure matters,
  // and an unreadable config would already have surfaced above.
  return parsed.fileNames.map(toRepoRelative);
}

/** Every project referenced by the solution `tsconfig.json`. */
function referencedProjects(): string[] {
  const solution = ts.readConfigFile(`${REPO_ROOT}tsconfig.json`, ts.sys.readFile);
  const references: Array<{ path: string }> = solution.config?.references ?? [];
  return references.map((reference) => `${REPO_ROOT}${reference.path.replace(/^\.\//, '')}`);
}

/** Union of the root files of every referenced project. */
function coveredFiles(): Set<string> {
  return new Set(referencedProjects().flatMap(rootFilesOf));
}

function trackedSourceFiles(): string[] {
  // -z: NUL-separated, so a path containing a newline cannot split one entry into two.
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split(String.fromCharCode(0))
    .filter(Boolean)
    .filter((file) => SOURCE_EXTENSION.test(file));
}

describe('OPS-75 every tracked source file is reached by a gate that parses it', () => {
  it('enumerates a plausible number of tracked source files and covered files', () => {
    // Anti-vacuity. A failed `git ls-files` or a wrong cwd yields an empty list, and the
    // per-file assertion below then passes by scanning nothing. Likewise a config graph
    // that failed to resolve would yield an empty covered set — which would fail loudly
    // below, but the floor states the expectation rather than leaving it implicit.
    const tracked = trackedSourceFiles();
    expect(tracked.length).toBeGreaterThan(60);
    expect(tracked).toContain(OBVIOUSLY_COVERED);
    for (const file of FORMERLY_UNGATED) expect(tracked).toContain(file);

    expect(coveredFiles().size).toBeGreaterThan(60);

    // The offender assertion below would also pass vacuously if the solution stopped
    // referencing the tooling project and `coveredFiles()` over-returned for some other
    // reason. Naming the project pins the arrangement this spec exists to protect.
    const projects = referencedProjects().map((path) => path.replace(REPO_ROOT, ''));
    expect(projects).toContain('tsconfig.tooling.json');
  });

  it('reports files outside every project as offenders', () => {
    // The discriminating control. Without it, an `offenders` array that is empty because
    // the set-difference is miscomputed — or because `coveredFiles()` accidentally returns
    // everything — would look exactly like success. Run the real offender computation
    // against a single project that covers only `src/`, and the tooling files must surface.
    const srcOnly = new Set(rootFilesOf(`${REPO_ROOT}tsconfig.app.json`));
    const offenders = trackedSourceFiles().filter((file) => !srcOnly.has(file));

    for (const file of FORMERLY_UNGATED) expect(offenders).toContain(file);
    // ...and it is a real difference, not "everything is an offender".
    expect(srcOnly.has(OBVIOUSLY_COVERED)).toBe(true);
    expect(offenders).not.toContain(OBVIOUSLY_COVERED);
  });

  it('leaves no tracked source file outside every project', () => {
    const covered = coveredFiles();
    const offenders = trackedSourceFiles().filter((file) => !covered.has(file));
    expect(offenders).toEqual([]);
  });
});
