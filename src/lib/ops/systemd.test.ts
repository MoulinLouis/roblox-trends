import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOB_CONFIG } from "@/lib/config";
import { JOB_NAMES, type JobName } from "@/lib/jobs/types";

const repository = new URL("../../../", import.meta.url);
const units = new URL("ops/systemd/", repository);
const unitFiles = readdirSync(units, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);
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

// The units cannot run in CI: these checks catch a misspelled unit or path before the server does.
describe("unit references", () => {
  const timers = unitFiles.filter((name) => name.endsWith(".timer"));
  const services = unitFiles.filter((name) => name.endsWith(".service"));
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
