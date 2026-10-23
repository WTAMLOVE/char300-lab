import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../start.sh", import.meta.url));

function runWithMockServices(command: string, siteState = "active", caddyState = "active") {
  const directory = mkdtempSync(join(tmpdir(), "char300-start-test-"));
  const logFile = join(directory, "commands.log");
  const systemctl = join(directory, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  '--user is-active char300.service') echo "$MOCK_SITE_STATE"; test "$MOCK_SITE_STATE" = active ;;
  '--user is-enabled char300.service') echo enabled ;;
  'is-active caddy') echo "$MOCK_CADDY_STATE"; test "$MOCK_CADDY_STATE" = active ;;
  'is-enabled caddy') echo enabled ;;
  'is-active --quiet caddy') test "$MOCK_CADDY_STATE" = active ;;
  'is-enabled --quiet caddy') exit 0 ;;
  '--user is-active --quiet char300.service') test "$MOCK_SITE_STATE" = active ;;
  '--user is-enabled --quiet char300.service') exit 0 ;;
  '--user disable --now char300.service') exit 0 ;;
  *) exit 2 ;;
esac
`);
  writeFileSync(join(directory, "sudo"), "#!/bin/sh\nprintf 'sudo %s\\n' \"$*\" >> \"$MOCK_LOG\"\n");
  writeFileSync(join(directory, "ss"), "#!/bin/sh\nprintf 'LISTEN 0 128 *:443 *:*\\n'\n");
  for (const executable of ["systemctl", "sudo", "ss"]) chmodSync(join(directory, executable), 0o755);
  try {
    const result = spawnSync("bash", [script, command], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOCK_LOG: logFile, MOCK_SITE_STATE: siteState, MOCK_CADDY_STATE: caddyState }
    });
    return { ...result, commands: readFileSync(logFile, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("status reports both services without starting or building", () => {
  const active = runWithMockServices("status");
  assert.equal(active.status, 0);
  assert.match(active.stdout, /项目服务 char300\.service：active/);
  assert.match(active.stdout, /Caddy 服务：active/);
  assert.match(active.stdout, /\*:443/);
  assert.doesNotMatch(active.commands, /sudo|disable|restart|pnpm/);

  const stopped = runWithMockServices("status", "inactive", "inactive");
  assert.equal(stopped.status, 1);
  assert.match(stopped.stdout, /项目服务 char300\.service：inactive/);
  assert.match(stopped.stdout, /Caddy 服务：inactive/);
});

test("stop disables both services without building the project", () => {
  const result = runWithMockServices("stop");
  assert.equal(result.status, 0);
  assert.match(result.commands, /sudo systemctl disable --now caddy/);
  assert.match(result.commands, /systemctl --user disable --now char300\.service/);
  assert.doesNotMatch(result.commands, /pnpm|restart/);
});
