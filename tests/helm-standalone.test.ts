import { expect, test } from "bun:test";

/**
 * The standalone chart target, rendered and held to its refusals.
 *
 * CI's chart job renders each `charts/openbot/ci/*-values.yaml` target through its
 * workflow matrix; until `standalone` is added there (a change that needs the
 * workflow permission), this test is the render coverage for the new mode — and it
 * remains the local answer to "does the chart still refuse what it should" either way.
 *
 * Skips when helm is not installed, and when the chart's dependencies cannot be
 * fetched (an offline machine), rather than failing on tooling the change did not touch.
 */

const helm = Bun.which("helm");

async function run(
  command: string[],
): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const status = await child.exited;
  return { ok: status === 0, output: stdout + stderr };
}

const KEY = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";

function template(
  ...extra: string[]
): Promise<{ ok: boolean; output: string }> {
  return run([
    helm ?? "helm",
    "template",
    "ci",
    "charts/openbot",
    "--values",
    "charts/openbot/ci/standalone-values.yaml",
    "--set-string",
    `secrets.keyEncryptionKey=${KEY}`,
    "--api-versions",
    "agents.x-k8s.io/v1beta1/Sandbox",
    "--api-versions",
    "extensions.agents.x-k8s.io/v1beta1/SandboxTemplate",
    ...extra,
  ]);
}

// Bun's `skip` option is a boolean — a reason string is not treated as true, which
// let this run (and fail on ENOENT) on machines without helm. skipIf is the honest
// form: skipped where helm is absent, which today includes the plain CI test job.
test.skipIf(!helm)(
  "the standalone chart target renders without Intelligence and refuses contradictions",
  { timeout: 120_000 },
  async () => {
    const dependencies = await run([
      helm ?? "helm",
      "dependency",
      "build",
      "charts/openbot",
    ]);
    if (!dependencies.ok) {
      // Offline: fetching the postgresql subchart is the part that failed, and it is
      // not what this test is about.
      console.warn("helm dependency build failed; skipping chart render test");
      return;
    }

    const rendered = await template();
    expect(rendered.ok).toBe(true);
    // The server is told its mode, and nothing Intelligence-shaped survives into the
    // manifests: no env pointing at the platform, no secret keys for it.
    expect(rendered.output).toContain("OPENBOT_RUNTIME_MODE");
    expect(rendered.output).not.toContain("INTELLIGENCE_API_URL");
    expect(rendered.output).not.toContain("intelligence-api-key");
    expect(rendered.output).not.toContain("license-token");

    // Standalone alongside Intelligence values is the contradiction the server also
    // refuses; the chart catches it at install instead of in a crash loop.
    const contradiction = await template(
      "--set",
      "config.intelligence.apiUrl=https://api.example",
    );
    expect(contradiction.ok).toBe(false);

    // A routines CronJob whose every dispatch is a 404 must not render.
    const routines = await template(
      "--set",
      "routines.enabled=true",
      "--set",
      "secrets.workerSharedSecret=example",
    );
    expect(routines.ok).toBe(false);

    // The operator escape hatch must not smuggle the mode back in: extraEnv entries
    // naming the runtime variables are refused in standalone rather than rendered
    // into a pod that validation never saw.
    const smuggled = await template(
      "--set",
      "config.extraEnv[0].name=INTELLIGENCE_API_URL",
      "--set",
      "config.extraEnv[0].value=https://api.example",
    );
    expect(smuggled.ok).toBe(false);
    const modeOverride = await template(
      "--set",
      "config.extraEnv[0].name=OPENBOT_RUNTIME_MODE",
      "--set",
      "config.extraEnv[0].value=intelligence",
    );
    expect(modeOverride.ok).toBe(false);
  },
);
