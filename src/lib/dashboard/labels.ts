// "trending-in-roleplay-and-avatar-sim" → "Trending in Roleplay & Avatar Sim".
export function chartLabel(sortId: string): string {
  return sortId
    .split("-")
    .map((word, index) => {
      if (word === "and") return "&";
      if (word === "rpg") return "RPG";
      if (index > 0 && (word === "in" || word === "with")) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

// Completes "First seen through …".
export function discoveryLabel(source: string, detail: string): string {
  switch (source) {
    case "rolimons":
      return "Rolimon's list";
    case "chart": {
      // Explore reads sorts by country: "up-and-coming:us".
      const [sortId, country] = detail.split(":");
      return country ? `the ${chartLabel(sortId)} chart in ${country.toUpperCase()}` : `the ${chartLabel(sortId)} chart`;
    }
    case "search":
      return `a search for “${detail}”`;
    case "recommendation":
      return `recommendations from universe ${detail}`;
    default:
      return detail ? `${source} (${detail})` : source;
  }
}
