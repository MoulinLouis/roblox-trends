import { AlertTriangle } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { dashboardDatabase } from "@/db/dashboard";
import type { JobSummary } from "@/db/status";
import { readHealth } from "@/lib/dashboard/health";
import { formatCount, formatElapsed, formatMinutes, formatPercent, formatUtc } from "@/lib/format";
import { formatStat, hasStat, statAt, type TailRefresh, WATCHED_STATS } from "@/lib/status-report";

export const metadata: Metadata = { title: "Health" };

export default async function HealthPage() {
  await connection();
  const now = new Date();
  const { windowHours, jobs, coverage, totals, rateLimits, tailRefresh, system } = await readHealth(dashboardDatabase(), now);
  const archived = system.lastArchivedAt ? `${formatElapsed(system.lastArchivedAt, now)} ago` : "never";
  const problems = system.problems.length;
  return (
    <div className="content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Health</p>
          <h1>Collection health</h1>
          <p className="page-subtitle">
            Job runs over the last {windowHours} hours, as of {formatUtc(now)}. Backups and the weekly restore test report
            to Healthchecks only.
          </p>
        </div>
      </div>
      <div className="grid grid-3">
        <MetricCard
          label="Coverage"
          value={formatPercent(coverage.listed ? coverage.tracked / coverage.listed : null)}
          detail={
            coverage.slot
              ? `${formatCount(coverage.tracked)} of ${formatCount(coverage.listed)} Rolimon's places at or above ${coverage.minimumCcu} CCU polled within ${formatMinutes(coverage.withinMinutes)}; list ${formatElapsed(coverage.slot, now)} old`
              : `No complete Rolimon's list in the last ${windowHours} h`
          }
        />
        {tailRefresh.map((lane) => <TailRefreshCard key={lane.lane} lane={lane} />)}
        <MetricCard
          label="Games known"
          value={formatCount(totals.games)}
          detail={`${formatCount(totals.pollObservations)} poll observations and ${formatCount(totals.censusRows)} census rows in ${windowHours} h`}
        />
        <MetricCard
          label="Roblox 429s"
          value={rateLimits.recorded ? `${formatCount(rateLimits.responses)} / ${formatCount(rateLimits.attempts)}` : "—"}
          tone={rateLimits.runs > 0 ? "warning" : undefined}
          detail={
            rateLimits.recorded
              ? `${formatPercent(rateLimits.attempts ? rateLimits.responses / rateLimits.attempts : null, 2)} of requests; ${formatCount(rateLimits.runs)} rate-limited runs`
              : "No requests recorded"
          }
        />
        <MetricCard
          label="System"
          value={system.ok ? "OK" : `${problems} problem${problems === 1 ? "" : "s"}`}
          tone={system.ok ? "positive" : "negative"}
          detail={`Disk ${formatPercent(system.diskUsedShare)} used; WAL archived ${archived}; ${system.policies} TimescaleDB policies`}
        />
      </div>
      {problems ? (
        <section className="section grid">
          {system.problems.map((problem) => (
            <div className="alert" key={problem}><AlertTriangle size={16} /><span>{problem}</span></div>
          ))}
        </section>
      ) : null}
      <section className="section">
        <div className="section-heading"><h2>Jobs</h2></div>
        <div className="card table-shell">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Job</th><th>Latest run</th><th>Last completed</th><th>Runs</th><th>Degraded</th><th>Failed</th>
                  <th>429s / requests</th><th>Details</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => <JobRow key={job.job} job={job} now={now} />)}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

const tailLaneCopy: Record<TailRefresh["lane"], { label: string; games: string }> = {
  young: { label: "Young games refresh", games: "young tail games, the ones the Radar lists" },
  established: { label: "Established games refresh", games: "established tail games, whose CCU census counts every 10 min" },
};

// Above its target, the lane waits longer than poll's budget was planned for: the tail outgrew it.
function TailRefreshCard({ lane }: { lane: TailRefresh }) {
  const copy = tailLaneCopy[lane.lane];
  return (
    <MetricCard
      label={copy.label}
      value={lane.minutes === null ? "—" : `${formatCount(lane.minutes)} min`}
      tone={lane.minutes !== null && lane.minutes > lane.targetMinutes ? "warning" : undefined}
      detail={`Median wait of the ${copy.games}, in the last poll run; target ${formatCount(lane.targetMinutes)} min`}
    />
  );
}

function JobRow({ job, now }: { job: JobSummary; now: Date }) {
  const watched = WATCHED_STATS[job.job];
  const stats = job.lastCompleted?.stats;
  return (
    <tr>
      <td><strong>{job.job}</strong></td>
      <td>
        {job.latest ? (
          <><StatusBadge status={job.latest.status} /><span className="table-subline">{formatElapsed(job.latest.startedAt, now)} ago</span></>
        ) : "never"}
      </td>
      <td>
        {job.lastCompleted ? (
          <><StatusBadge status={job.lastCompleted.status} /><span className="table-subline">{formatElapsed(job.lastCompleted.finishedAt, now)} ago</span></>
        ) : "never"}
      </td>
      <td>{formatCount(job.recent.runs)}</td>
      <td className={job.recent.degraded ? "warning" : undefined}>{formatCount(job.recent.degraded)}</td>
      <td className={job.recent.failed ? "negative" : undefined}>{formatCount(job.recent.failed)}</td>
      <td>{job.recent.http ? `${formatCount(job.recent.http.rateLimitedResponses)} / ${formatCount(job.recent.http.attempts)}` : "—"}</td>
      <td>
        {watched && stats ? (
          <span className="stat-line">{watched.values.map((path) => `${path}=${formatStat(statAt(stats, path))}`).join(" ")}</span>
        ) : null}
        {watched && stats
          ? (watched.messages ?? [])
              .filter((path) => hasStat(stats, path))
              .map((path) => <span className="stat-line warning" key={path}>{path}: {formatStat(statAt(stats, path))}</span>)
          : null}
        {job.lastError ? (
          <span className="stat-line negative">Error {formatElapsed(job.lastError.startedAt, now)} ago: {job.lastError.message}</span>
        ) : null}
      </td>
    </tr>
  );
}
