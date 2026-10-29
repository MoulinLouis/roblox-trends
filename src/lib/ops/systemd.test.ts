import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOB_CONFIG } from "@/lib/config";
import { JOB_NAMES, type JobName } from "@/lib/jobs/types";

const repository = new URL("../../../", import.meta.url);
const units = new URL("ops/systemd/", repository);
const unitEntries = readdirSync(units, { withFileTypes: true });
const unitFiles = unitEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
const dropInDirectories = unitEntries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".d")).map((entry) => entry.name);
const services = unitFiles.filter((name) => name.endsWith(".service")).sort();
const dependencies = Object.keys(
  (JSON.parse(readFileSync(new URL("package.json", repository), "utf8")) as { dependencies?: Record<string, string> })
    .dependencies ?? {},
);

// The settings of a unit file, by key (sections are ignored: no key here appears in two sections).
function readUnit(path: string): Map<string, string[]> {
  const settings = new Map<string, string[]>();
  for (const line of readFileSync(new URL(path, units), "utf8").split("\n")) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (match) settings.set(match[1], [...(settings.get(match[1]) ?? []), match[2]]);
  }
  return settings;
}

// A service with its drop-ins; for a template, the drop-ins of every instance (radar-job@poll.service.d) count.
function readServiceWithDropIns(name: string): Map<string, string[]> {
  const settings = readUnit(name);
  const instancePrefix = name.endsWith("@.service") ? name.slice(0, -".service".length) : undefined;
  for (const directory of dropInDirectories) {
    const unit = directory.slice(0, -".d".length);
    if (unit !== name && !(instancePrefix && unit.startsWith(instancePrefix))) continue;
    for (const file of readdirSync(new URL(`${directory}/`, units)).filter((entry) => entry.endsWith(".conf"))) {
      for (const [key, values] of readUnit(`${directory}/${file}`)) settings.set(key, [...(settings.get(key) ?? []), ...values]);
    }
  }
  return settings;
}

function onlySetting(unit: Map<string, string[]>, key: string): string | undefined {
  const values = unit.get(key) ?? [];
  expect(values.length, key).toBeLessThanOrEqual(1);
  return values[0];
}

// "*:M/S:SS" repeats every S minutes from minute M; "*:MM:SS" runs once an hour.
function startTimes(onCalendar: string): { step: number; offsetSeconds: number; minutes: number[] } {
  const repeated = /^\*:(\d+)\/(\d+):(\d{2})$/.exec(onCalendar);
  const hourly = /^\*:(\d{2}):(\d{2})$/.exec(onCalendar);
  if (repeated) {
    const [first, step, second] = repeated.slice(1).map(Number);
    const minutes = Array.from({ length: 60 / step }, (_, index) => first + index * step);
    return { step, offsetSeconds: first * 60 + second, minutes };
  }
  if (hourly) {
    const [minute, second] = hourly.slice(1).map(Number);
    return { step: 60, offsetSeconds: minute * 60 + second, minutes: [minute] };
  }
  throw new Error(`Unsupported OnCalendar: ${onCalendar}`);
}

function jobTimer(name: JobName) {
  return readUnit(`radar-${name}.timer`);
}

describe("job timers", () => {
  it.each(JOB_NAMES)("starts %s once per slot of its interval, inside the slot, without jitter", (name) => {
    const timer = jobTimer(name);
    expect(onlySetting(timer, "Unit")).toBe(`radar-job@${name}.service`);
    expect(onlySetting(timer, "AccuracySec")).toBe("1s");
    expect(onlySetting(timer, "Persistent")).toBe("false");
    // A jittered start can put two runs in one slot (the slot is the floor of the start time) and leave the next empty.
    expect(timer.has("RandomizedDelaySec")).toBe(false);
    const { step, offsetSeconds } = startTimes(onlySetting(timer, "OnCalendar") ?? "");
    const intervalSeconds = JOB_CONFIG[name].intervalMinutes * 60;
    expect(step).toBe(JOB_CONFIG[name].intervalMinutes);
    expect(offsetSeconds).toBeGreaterThanOrEqual(20);
    expect(offsetSeconds).toBeLessThanOrEqual(intervalSeconds - 20);
  });

  it("never starts two jobs in the same minute, since they share Roblox hosts and each spaces only its own requests", () => {
    const seen = new Map<number, JobName>();
    for (const name of JOB_NAMES) {
      for (const minute of startTimes(onlySetting(jobTimer(name), "OnCalendar") ?? "").minutes) {
        expect(seen.get(minute), `${name} at minute ${minute}`).toBeUndefined();
        seen.set(minute, name);
      }
    }
  });

  it.each(JOB_NAMES)("gives %s a systemd timeout just above its own", (name) => {
    const path = `radar-job@${name}.service.d/timeout.conf`;
    expect(existsSync(new URL(path, units))).toBe(true);
    expect(onlySetting(readUnit(path), "TimeoutStartSec")).toBe(String(Math.ceil(JOB_CONFIG[name].timeoutMs / 1_000) + 30));
  });
});

describe("job service", () => {
  const service = readUnit("radar-job@.service");

  it("runs the job of its instance as radar from the live release, with monitoring required", () => {
    expect(onlySetting(service, "Type")).toBe("oneshot");
    expect(onlySetting(service, "User")).toBe("radar");
    expect(onlySetting(service, "WorkingDirectory")).toBe("/opt/radar/current");
    expect(onlySetting(service, "ExecStart")).toBe("/opt/radar/current/node_modules/.bin/tsx scripts/job.ts %i");
    expect(service.get("Environment")).toContain("RADAR_REQUIRE_HEALTHCHECKS=1");
    expect(onlySetting(service, "OnFailure")).toBe("radar-job-failed@%i.service");
  });
});

describe("system check service", () => {
  const service = readUnit("radar-system-check.service");

  it("runs the system check as radar from the live release, with monitoring required", () => {
    expect(onlySetting(service, "Type")).toBe("oneshot");
    expect(onlySetting(service, "User")).toBe("radar");
    expect(onlySetting(service, "WorkingDirectory")).toBe("/opt/radar/current");
    expect(onlySetting(service, "ExecStart")).toBe("/opt/radar/current/node_modules/.bin/tsx scripts/system-check.ts");
    expect(service.get("Environment")).toContain("RADAR_REQUIRE_HEALTHCHECKS=1");
  });
});

// Root runs ops/bin and installs ops/systemd from the live release: no process of the radar user may write there.
describe("services of the radar user", () => {
  const cache = "/opt/radar/current/.next/cache";
  const radarServices = services.filter((name) => readServiceWithDropIns(name).get("User")?.includes("radar"));

  it("finds them", () => {
    expect(radarServices).toEqual(["radar-job@.service", "radar-system-check.service", "radar-web.service"]);
  });

  it.each(radarServices)("%s sees a read-only system, except the Next.js cache, and cannot gain privileges", (name) => {
    const service = readServiceWithDropIns(name);
    expect([...new Set(service.get("ProtectSystem"))]).toEqual(["strict"]);
    expect([...new Set(service.get("NoNewPrivileges"))]).toEqual(["yes"]);
    const writable = (service.get("ReadWritePaths") ?? [])
      .flatMap((value) => value.split(/\s+/))
      .filter(Boolean)
      .map((path) => path.replace(/^[-+]+/, ""));
    for (const path of writable) expect(path, name).toBe(cache);
  });

  it("lets the dashboard write its cache", () => {
    expect(readUnit("radar-web.service").get("ReadWritePaths")).toEqual([`-${cache}`]);
  });
});

// The units cannot run in CI: these checks catch a misspelled unit or path before the server does.
describe("unit references", () => {
  const timers = unitFiles.filter((name) => name.endsWith(".timer"));
  const release = "/opt/radar/current/";
  // The binaries a unit may run from the release, by the package that installs them.
  const binaries: Record<string, string> = { "node_modules/.bin/tsx": "tsx", "node_modules/.bin/next": "next" };

  it("finds the timers and services", () => {
    expect(timers).toEqual(expect.arrayContaining(JOB_NAMES.map((name) => `radar-${name}.timer`)));
    expect(services).toEqual(expect.arrayContaining(["radar-job@.service", "radar-system-check.service"]));
  });

  it.each(timers)("%s starts a unit of ops/systemd", (timer) => {
    const unit = onlySetting(readUnit(timer), "Unit") ?? "";
    // systemd cannot start a template itself, only an instance of it.
    expect(unit).toMatch(/^[\w-]+(@[\w-]+)?\.service$/);
    // An instance such as radar-job@poll.service is loaded from its template, radar-job@.service.
    const file = unitFiles.includes(unit) ? unit : unit.replace(/@[\w-]+\./, "@.");
    expect(unitFiles, `${timer} starts ${unit}`).toContain(file);
  });

  it.each(services)("%s runs a file of the live release", (service) => {
    const unit = readUnit(service);
    const [command, ...args] = (onlySetting(unit, "ExecStart") ?? "").split(/\s+/);
    // Required rather than skipped, so a misspelled release path cannot bypass the checks below.
    expect(command.startsWith(release), command).toBe(true);
    const path = command.slice(release.length);
    if (path in binaries) {
      expect(dependencies, `${path} comes from a dependency`).toContain(binaries[path]);
      // tsx and next resolve their arguments and the application from the working directory.
      expect(onlySetting(unit, "WorkingDirectory")).toBe("/opt/radar/current");
      if (binaries[path] === "tsx") {
        expect(args[0]).toMatch(/^scripts\/[\w-]+\.ts$/);
        expect(existsSync(new URL(args[0], repository)), args[0]).toBe(true);
      }
    } else {
      expect(path).toMatch(/^ops\/bin\/[\w-]+\.sh$/);
      expect(existsSync(new URL(path, repository)), path).toBe(true);
    }
  });
});

describe("job timers and the deploy script", () => {
  it("lists every job timer, so a migration pauses all of them", () => {
    const deploy = readFileSync(new URL("ops/bin/deploy.sh", repository), "utf8");
    const listed = /^readonly job_timers=\((.*)\)$/m.exec(deploy)?.[1].split(/\s+/);
    expect([...(listed ?? [])].sort()).toEqual(JOB_NAMES.map((name) => `radar-${name}.timer`).sort());
  });
});

describe("the Anthropic key", () => {
  const keyFile = "/etc/radar/anthropic.env";
  const dropIns = dropInDirectories.flatMap((directory) =>
    readdirSync(new URL(`${directory}/`, units))
      .filter((entry) => entry.endsWith(".conf"))
      .map((entry) => `${directory}/${entry}`),
  );
  const environmentFiles = [...unitFiles, ...dropIns].flatMap((path) =>
    (readUnit(path).get("EnvironmentFile") ?? []).map((value) => ({ path, value })),
  );

  it("is loaded by the classify job only, and its absence fails the unit", () => {
    const loading = environmentFiles.filter(({ value }) => value.replace(/^-/, "") === keyFile);
    expect(loading).toEqual([{ path: "radar-job@classify.service.d/anthropic.conf", value: keyFile }]);
  });
});
