import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEALTHCHECKS_CONFIG } from "@/lib/config";
import { jobSlug } from "@/lib/jobs/healthchecks";

const bin = new URL("../../../ops/bin/", import.meta.url);
const script = (name: string) => readFileSync(new URL(name, bin), "utf8");
const scripts = ["provision.sh", "configure-database.sh", "configure-backups.sh", "deploy.sh", "backup.sh", "restore-test.sh", "job-failed.sh", "radar.sh"];

describe("operations scripts", () => {
  it("lists every script of ops/bin, so each one is checked below", () => {
    expect(readdirSync(bin).sort()).toEqual([...scripts].sort());
  });

  it.each(scripts)("%s is an executable strict bash script", (name) => {
    expect(script(name).startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script(name)).toContain("set -euo pipefail");
    expect(statSync(new URL(name, bin)).mode & 0o111).not.toBe(0);
  });

  it("ping the Healthchecks slugs the provisioning creates", () => {
    const { deploy, backup, restoreTest } = HEALTHCHECKS_CONFIG.operations;
    expect(script("deploy.sh")).toContain(`/${deploy.slug}\${1}`);
    expect(script("backup.sh")).toContain(`/${backup.slug}\${1}`);
    expect(script("restore-test.sh")).toContain(`/${restoreTest.slug}\${1}`);
    // job-failed.sh builds radar-<job> like jobSlug.
    expect(jobSlug("poll")).toBe("radar-poll");
    expect(script("job-failed.sh")).toContain("/radar-${job}/fail");
  });

  it("pins the TimescaleDB version of the CI image", () => {
    const image = /timescale\/timescaledb:([\d.]+)-pg18/.exec(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"));
    expect(script("provision.sh")).toContain(`readonly timescaledb_version=${image?.[1]}`);
  });
});
