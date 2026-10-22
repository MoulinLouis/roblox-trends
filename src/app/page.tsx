import type { Metadata } from "next";
import { connection } from "next/server";
import { RisingGamesTable } from "@/components/RisingGamesTable";
import { dashboardDatabase } from "@/db/dashboard";
import { type RadarSort, risingGames } from "@/db/radar";
import { RADAR_CONFIG } from "@/lib/config";
import { parseRadarQuery, toDateTimeInput } from "@/lib/dashboard/radar-query";
import { formatCount, formatUtc } from "@/lib/format";

export const metadata: Metadata = { title: "Radar" };

const sortLabels: Record<RadarSort, string> = {
  growth: "Growth vs last week",
  acceleration: "Growth vs the day before",
  ccu: `Average CCU over ${RADAR_CONFIG.windowHours} h`,
  age: "Newest",
};

export default async function RadarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const now = new Date();
  const query = parseRadarQuery(await searchParams, now);
  const asOf = query.asOf ?? now;
  const games = await risingGames(dashboardDatabase(), {
    asOf,
    maxAgeDays: query.maxAgeDays,
    minimumCcu: query.minimumCcu,
    sort: query.sort,
    limit: RADAR_CONFIG.pageSize,
  });
  return (
    <div className="content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Radar</p>
          <h1>Rising games</h1>
          <p className="page-subtitle">
            Games created within {query.maxAgeDays} days with at least {formatCount(query.minimumCcu)} CCU on average over
            the last {RADAR_CONFIG.windowHours} whole hours, as of {formatUtc(asOf)}. Growth vs last week compares each
            game&apos;s share of tracked CCU with the same hours a week earlier, so weekends do not count as growth.
          </p>
        </div>
      </div>
      <div className="card table-shell">
        <form className="filters radar-filters" method="get">
          <div className="field">
            <label htmlFor="age">Created within</label>
            <select id="age" name="age" className="select" defaultValue={query.maxAgeDays}>
              {RADAR_CONFIG.ageOptionsDays.map((days) => <option key={days} value={days}>{days} days</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="minCcu">Minimum CCU</label>
            <select id="minCcu" name="minCcu" className="select" defaultValue={query.minimumCcu}>
              {RADAR_CONFIG.minimumCcuOptions.map((ccu) => <option key={ccu} value={ccu}>{formatCount(ccu)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sort">Sort by</label>
            <select id="sort" name="sort" className="select" defaultValue={query.sort}>
              {Object.entries(sortLabels).map(([sort, label]) => <option key={sort} value={sort}>{label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="asOf">As of (UTC, empty for now)</label>
            <input id="asOf" name="asOf" type="datetime-local" className="input" defaultValue={query.asOf ? toDateTimeInput(query.asOf) : ""} max={toDateTimeInput(now)} />
          </div>
          <button className="button primary" type="submit">Apply</button>
        </form>
        <RisingGamesTable games={games} asOf={asOf} />
      </div>
    </div>
  );
}
