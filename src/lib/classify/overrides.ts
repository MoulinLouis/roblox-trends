import type { ComparedField } from "./compare";

// A value the owner decided for one field of one game. The classify job will apply it over the model's answer, so a
// reviewed game keeps the reviewed value whatever model or prompt version classifies it.
export interface ClassificationOverride {
  universeId: number;
  field: Exclude<ComparedField, "format">;
  value: string;
  reason: string;
  decidedAt: string; // YYYY-MM-DD
}

// The owner's reviews of 2026-10-29, answered blind between Opus and Sonnet: review-1 (prompt v2, all four fields) and
// review-2 (prompt v3, only the format fields where the models differed), under .data/classification/. Every field
// where the owner chose between two differing answers or wrote a value has an entry; confirmed shared answers, and
// fields where both answers were accepted, have none. Core action choices are often a wording preference.
export const CLASSIFICATION_OVERRIDES: readonly ClassificationOverride[] = [
  { universeId: 2278167893, field: "template", value: "Falling {thing} Block", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // Falling Color Block
  { universeId: 6862377948, field: "coreAction", value: "hide from killer", reason: "Owner review of review-1: chosen over \"hide from killers\".", decidedAt: "2026-10-29" }, // Sprunki Killer
  { universeId: 7341957983, field: "family", value: "shooter", reason: "Owner review of review-1: chosen over \"killers vs survivors\".", decidedAt: "2026-10-29" }, // DOOMED 2 DIE Classic
  { universeId: 7341957983, field: "coreAction", value: "shoot enemies", reason: "Owner review of review-1: chosen over \"survive rounds\".", decidedAt: "2026-10-29" }, // DOOMED 2 DIE Classic
  { universeId: 7907828295, field: "rewardLoop", value: "pets", reason: "Owner review of review-2: chosen over \"catches\".", decidedAt: "2026-10-29" }, // Steal A Fish
  { universeId: 8140627455, field: "rewardLoop", value: "characters", reason: "Owner review of review-1: chosen over \"money\".", decidedAt: "2026-10-29" }, // Steal a SpongeBob
  { universeId: 9040771693, field: "template", value: "{thing} Easy Obby", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // Mega Easy Obby 250+ Stages
  { universeId: 9143539023, field: "family", value: "Steal a", reason: "Owner review of review-1: chosen over \"escape\".", decidedAt: "2026-10-29" }, // Steal a Baby Verity
  { universeId: 9143539023, field: "rewardLoop", value: "characters", reason: "Owner review of review-1: the stolen units are not brainrots; the owner wrote \"verities\", recorded as the shared value.", decidedAt: "2026-10-29" }, // Steal a Baby Verity
  { universeId: 9143539023, field: "coreAction", value: "steal verities", reason: "Owner review of review-1: corrected from \"steal babies\".", decidedAt: "2026-10-29" }, // Steal a Baby Verity
  { universeId: 9194711658, field: "template", value: "Steal a {thing}", reason: "Owner review of review-2: chosen over \"{thing} RP\".", decidedAt: "2026-10-29" }, // (CRAFT)Steal A Brainrot Roleplay and Trading
  { universeId: 9449734205, field: "coreAction", value: "ride skateboard", reason: "Owner review of review-1: chosen over \"ride skateboards\".", decidedAt: "2026-10-29" }, // +1 Speed Skateboard Escape
  { universeId: 9491545867, field: "rewardLoop", value: "brainrots", reason: "Owner review of review-2: chosen over \"eggs\".", decidedAt: "2026-10-29" }, // Break a Brainrot Egg!
  { universeId: 9679187246, field: "family", value: "{verb} for {reward}", reason: "Owner review of review-1: chosen over \"escape\".", decidedAt: "2026-10-29" }, // Escape Phones For Brainrot!
  { universeId: 9679187246, field: "template", value: "{verb} for {reward}", reason: "Owner review of review-1: chosen over \"Escape {danger}\".", decidedAt: "2026-10-29" }, // Escape Phones For Brainrot!
  { universeId: 9679772435, field: "template", value: "Steal a {thing}", reason: "Owner review of review-2: chosen over \"Steal From {thing}\".", decidedAt: "2026-10-29" }, // Steal From Animes
  { universeId: 9754259417, field: "coreAction", value: "fight players", reason: "Owner review of review-1: chosen over \"slash rivals\".", decidedAt: "2026-10-29" }, // Katana Arena
  { universeId: 9940944640, field: "rewardLoop", value: "characters", reason: "Owner review of review-1: the stolen units are not brainrots; the owner wrote \"peru\", recorded as the shared value.", decidedAt: "2026-10-29" }, // Steal a Peru
  { universeId: 9940944640, field: "coreAction", value: "steal memes", reason: "Owner review of review-1: chosen over \"steal brainrots\".", decidedAt: "2026-10-29" }, // Steal a Peru
  { universeId: 10004760418, field: "coreAction", value: "roller skate", reason: "Owner review of review-1: chosen over \"roll for brainrots\".", decidedAt: "2026-10-29" }, // Roller for Brainrots!
  { universeId: 10020612607, field: "coreAction", value: "arm wrestle", reason: "Owner review of review-1: chosen over \"walk for strength\".", decidedAt: "2026-10-29" }, // +1 Muscle to Arm Wrestle
  { universeId: 10145063057, field: "coreAction", value: "run stages", reason: "Owner review of review-1: chosen over \"run escape course\".", decidedAt: "2026-10-29" }, // +1 Speed Anime Escape
  { universeId: 10251256841, field: "family", value: "tycoon", reason: "Owner review of review-2: chosen over \"gardening\".", decidedAt: "2026-10-29" }, // Fruit Farm Empire
  { universeId: 10251256841, field: "template", value: "{thing} Empire", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // Fruit Farm Empire
  { universeId: 10251256841, field: "rewardLoop", value: "plants", reason: "Owner review of review-2: chosen over \"money\".", decidedAt: "2026-10-29" }, // Fruit Farm Empire
  { universeId: 10270331748, field: "rewardLoop", value: "collectibles", reason: "Owner review of review-1: chosen over \"pets\".", decidedAt: "2026-10-29" }, // +1 Run for NEEDOH!
  { universeId: 10274447949, field: "coreAction", value: "fly obby", reason: "Owner review of review-1: chosen over \"fly through obstacles\".", decidedAt: "2026-10-29" }, // +1 Wings Obby Escape
  { universeId: 10393076729, field: "rewardLoop", value: "characters", reason: "Owner review of review-1: the stolen units are not brainrots; the owner wrote \"badr\", recorded as the shared value.", decidedAt: "2026-10-29" }, // Steal a badr !
  { universeId: 10517914702, field: "template", value: "Steal a {thing}", reason: "Owner review of review-1: chosen over \"{verb} to Steal a {thing}\".", decidedAt: "2026-10-29" }, // Steal And Become a Brainrot! +1 Speed
  { universeId: 10550305160, field: "family", value: "physics sandbox", reason: "Owner review of review-1: chosen over \"other\".", decidedAt: "2026-10-29" }, // Breaking Roblox's Limits
  { universeId: 10550305160, field: "coreAction", value: "break limits", reason: "Owner review of review-1: chosen over \"travel distance\".", decidedAt: "2026-10-29" }, // Breaking Roblox's Limits
  { universeId: 10602518983, field: "rewardLoop", value: "eggs", reason: "Owner review of review-1: chosen over \"brainrots\".", decidedAt: "2026-10-29" }, // Don’t Break the Bobo Egg
  { universeId: 10620000247, field: "rewardLoop", value: "powers", reason: "Owner review of review-1: chosen over \"units\".", decidedAt: "2026-10-29" }, // +1 Wings For Anime!
  { universeId: 10620000247, field: "coreAction", value: "fly for fighters", reason: "Owner review of review-1: chosen over \"fly over lava\".", decidedAt: "2026-10-29" }, // +1 Wings For Anime!
  { universeId: 10714697542, field: "family", value: "RNG", reason: "Owner review of review-2: chosen over \"{verb} a {thing}\".", decidedAt: "2026-10-29" }, // Spin a Car And Race!
  { universeId: 10762757054, field: "family", value: "killers vs survivors", reason: "Owner review of review-1: chosen over \"party\".", decidedAt: "2026-10-29" }, // WHO FARTED?
  { universeId: 10764105376, field: "rewardLoop", value: "collectibles", reason: "Owner review of review-2: chosen over \"money\".", decidedAt: "2026-10-29" }, // Junkyard Simulator
  { universeId: 10764591320, field: "coreAction", value: "chat with ais", reason: "Owner review of review-1: chosen over \"talk to AIs\".", decidedAt: "2026-10-29" }, // AI Town
  { universeId: 10764670212, field: "coreAction", value: "run from monster", reason: "Owner review of review-1: chosen over \"hide from monster\".", decidedAt: "2026-10-29" }, // Cat in the Hat - Neighborhood
  { universeId: 10764693801, field: "family", value: "sales sim", reason: "Owner review of review-2: chosen over \"AI chat\".", decidedAt: "2026-10-29" }, // AI Salesman
  { universeId: 10764820667, field: "coreAction", value: "swing on ropes", reason: "Owner review of review-1: chosen over \"swing ropes\".", decidedAt: "2026-10-29" }, // Swing Obby for Eggs
  { universeId: 10764926550, field: "coreAction", value: "survive", reason: "Owner review of review-1: chosen over \"survive rounds\".", decidedAt: "2026-10-29" }, // survive simulator
  { universeId: 10764977990, field: "template", value: "{thing} Practice", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // Bomb Jump Practice (MM2)
  { universeId: 10765012427, field: "family", value: "{verb} a {thing}", reason: "Owner review of review-1: chosen over \"simulator\".", decidedAt: "2026-10-29" }, // Build the Pyramid!
  { universeId: 10765121931, field: "coreAction", value: "survive monster", reason: "Owner review of review-1: chosen over \"survive killer\".", decidedAt: "2026-10-29" }, // MM2 of The Locust
  { universeId: 10765295082, field: "family", value: "{verb} for {reward}", reason: "Owner review of review-2: chosen over \"{verb} a {thing}\".", decidedAt: "2026-10-29" }, // Pull Giant Eggs
  { universeId: 10765295082, field: "template", value: "{verb} a {thing}", reason: "Owner review of review-2: chosen over \"{verb} {thing}\".", decidedAt: "2026-10-29" }, // Pull Giant Eggs
  { universeId: 10765491459, field: "template", value: "{thing} Arena", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // Superhero Arena
  { universeId: 10765491459, field: "rewardLoop", value: "characters", reason: "Owner review of review-2: chosen over \"powers\".", decidedAt: "2026-10-29" }, // Superhero Arena
  { universeId: 10765597889, field: "family", value: "anime RPG", reason: "Owner review of review-1: chosen over \"cultivation RPG\".", decidedAt: "2026-10-29" }, // Cultivation: 10,000 Lives
  { universeId: 10765597889, field: "coreAction", value: "meditate", reason: "Owner review of review-1: chosen over \"cultivate qi\".", decidedAt: "2026-10-29" }, // Cultivation: 10,000 Lives
  { universeId: 10765674331, field: "coreAction", value: "dig and mine", reason: "Owner review of review-1: chosen over \"mine blocks\".", decidedAt: "2026-10-29" }, // Craft, Dig & Mine
  { universeId: 10766389071, field: "family", value: "simulator", reason: "Owner review of review-2: chosen over \"tycoon\".", decidedAt: "2026-10-29" }, // Build a Gym and Mog
  { universeId: 10766389071, field: "rewardLoop", value: "stats", reason: "Owner review of review-2: chosen over \"money\".", decidedAt: "2026-10-29" }, // Build a Gym and Mog
  { universeId: 10766476845, field: "family", value: "tower defense", reason: "Owner review of review-2: chosen over \"simulator\".", decidedAt: "2026-10-29" }, // Build An Anime Army
  { universeId: 10766578375, field: "coreAction", value: "hide from monsters", reason: "Owner review of review-1: chosen over \"collect groceries\".", decidedAt: "2026-10-29" }, // Aisles Of The Locust
  { universeId: 10766615705, field: "family", value: "tycoon", reason: "Owner review of review-1: chosen over \"RNG\".", decidedAt: "2026-10-29" }, // Food Trip sa Street
  { universeId: 10766615705, field: "rewardLoop", value: "rarity rolls", reason: "Owner review of review-1: chosen over \"money\".", decidedAt: "2026-10-29" }, // Food Trip sa Street
  { universeId: 10766615705, field: "coreAction", value: "roll foods", reason: "Owner review of review-1: chosen over \"roll street food\".", decidedAt: "2026-10-29" }, // Food Trip sa Street
  { universeId: 10766624580, field: "rewardLoop", value: "stats", reason: "Owner review of review-1: chosen over \"none\".", decidedAt: "2026-10-29" }, // Volleyball Rising!
  { universeId: 10766761638, field: "family", value: "hidden object", reason: "Owner review of review-1: chosen over \"puzzle\".", decidedAt: "2026-10-29" }, // Find The 4 Leaf Clover
  { universeId: 10766761638, field: "coreAction", value: "find clover", reason: "Owner review of review-1: chosen over \"pick clovers\".", decidedAt: "2026-10-29" }, // Find The 4 Leaf Clover
  { universeId: 10766767862, field: "family", value: "+1", reason: "Owner review of review-1: chosen over \"other\".", decidedAt: "2026-10-29" }, // Reel Tongue and Slide
  { universeId: 10766767862, field: "coreAction", value: "extend tongue", reason: "Owner review of review-1: chosen over \"shoot tongue\".", decidedAt: "2026-10-29" }, // Reel Tongue and Slide
  { universeId: 10766812244, field: "family", value: "{verb} a {thing}", reason: "Owner review of review-1: chosen over \"destruction\".", decidedAt: "2026-10-29" }, // Crack The Egg
  { universeId: 10766812244, field: "coreAction", value: "crack egg", reason: "Owner review of review-1: chosen over \"crack eggs\".", decidedAt: "2026-10-29" }, // Crack The Egg
  { universeId: 10766859137, field: "family", value: "draft battle", reason: "Owner review of review-1: chosen over \"sports\".", decidedAt: "2026-10-29" }, // Basketball Draft Battle
  { universeId: 10766859137, field: "template", value: "{thing} Draft Battle", reason: "Owner review of review-1: chosen over \"none\".", decidedAt: "2026-10-29" }, // Basketball Draft Battle
  { universeId: 10767094794, field: "coreAction", value: "answer questions", reason: "Owner review of review-1: chosen over \"answer quiz questions\".", decidedAt: "2026-10-29" }, // How Similar Are You?
  { universeId: 10767388396, field: "family", value: "simulator", reason: "Owner review of review-1: chosen over \"{verb} a {thing}\".", decidedAt: "2026-10-29" }, // Peel 1 Million Potatoes
  { universeId: 10767388396, field: "template", value: "{verb} a {thing}", reason: "Owner review of review-1: chosen over \"none\".", decidedAt: "2026-10-29" }, // Peel 1 Million Potatoes
  { universeId: 10767609708, field: "template", value: "Learn to {verb}", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // Learn to Fly
  { universeId: 10767619742, field: "coreAction", value: "use portal gun", reason: "Owner review of review-1: chosen over \"shoot portals\".", decidedAt: "2026-10-29" }, // Portal Sandbox
  { universeId: 10767641664, field: "rewardLoop", value: "vehicles", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // (NEW MAP) Dune Drivers
  { universeId: 10767665284, field: "rewardLoop", value: "powers", reason: "Owner review of review-1: chosen over \"money\".", decidedAt: "2026-10-29" }, // Tornado Summoner VS Town
  { universeId: 10767708612, field: "template", value: "Mount {name}", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // MOUNT PAGI
  { universeId: 10767909355, field: "template", value: "Become a {thing}", reason: "Owner review of review-2: chosen over \"Be a {thing}\".", decidedAt: "2026-10-29" }, // Become a Pop Star
  { universeId: 10767981720, field: "template", value: "{thing} Incremental", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // Zhuan Incremental 2
  { universeId: 10768052675, field: "family", value: "roleplay", reason: "Owner review of review-2: chosen over \"horror\".", decidedAt: "2026-10-29" }, // قريه الجنوب
  { universeId: 10768069442, field: "coreAction", value: "hatch eggs", reason: "Owner review of review-1: chosen over \"hatch troops\".", decidedAt: "2026-10-29" }, // Egg Tower Defense
  { universeId: 10768105757, field: "family", value: "gladiator RPG", reason: "Owner review of review-1: chosen over \"other\".", decidedAt: "2026-10-29" }, // Gladiator Life
  { universeId: 10768214226, field: "rewardLoop", value: "money", reason: "Owner review of review-1: chosen over \"pets\".", decidedAt: "2026-10-29" }, // Lolcat Clicker
  { universeId: 10768422548, field: "rewardLoop", value: "progress", reason: "Owner review of review-1: chosen over \"none\".", decidedAt: "2026-10-29" }, // PIPES
  { universeId: 10768422548, field: "coreAction", value: "hide from monsters", reason: "Owner review of review-1: chosen over \"fix pipes\".", decidedAt: "2026-10-29" }, // PIPES
  { universeId: 10768464991, field: "rewardLoop", value: "catches", reason: "Owner review of review-1: corrected from \"pets\".", decidedAt: "2026-10-29" }, // PBF
  { universeId: 10768763713, field: "family", value: "other", reason: "Owner review of review-1: chosen over \"anomaly\".", decidedAt: "2026-10-29" }, // Heaven or Hell
  { universeId: 10768907380, field: "family", value: "simulator", reason: "Owner review of review-2: chosen over \"+1\".", decidedAt: "2026-10-29" }, // Egg Skipping
  { universeId: 10768907380, field: "template", value: "{thing} Skipping", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // Egg Skipping
  { universeId: 10768951065, field: "coreAction", value: "wallhop walls", reason: "Owner review of review-1: chosen over \"wallhop up walls\".", decidedAt: "2026-10-29" }, // Trolls love this Wallhop
  { universeId: 10769204603, field: "family", value: "tycoon", reason: "Owner review of review-1: chosen over \"city builder\".", decidedAt: "2026-10-29" }, // Cities at War
  { universeId: 10769204603, field: "coreAction", value: "build cities", reason: "Owner review of review-1: chosen over \"build city\".", decidedAt: "2026-10-29" }, // Cities at War
  { universeId: 10769225661, field: "template", value: "{verb} the {thing}", reason: "Owner review of review-1: chosen over \"none\".", decidedAt: "2026-10-29" }, // Rule The Globe
  { universeId: 10769225661, field: "rewardLoop", value: "progress", reason: "Owner review of review-1: chosen over \"none\".", decidedAt: "2026-10-29" }, // Rule The Globe
  { universeId: 10769345301, field: "template", value: "none", reason: "Owner review of review-2: chosen over \"{thing} Makeup Showdown\".", decidedAt: "2026-10-29" }, // Paint Me Makeup Showdown
  { universeId: 10769345301, field: "rewardLoop", value: "none", reason: "Owner review of review-2: chosen over \"cosmetics\".", decidedAt: "2026-10-29" }, // Paint Me Makeup Showdown
  { universeId: 10769362627, field: "family", value: "simulator", reason: "Owner review of review-1: chosen over \"{verb} a {thing}\".", decidedAt: "2026-10-29" }, // EAT the Groceries!!!
  { universeId: 10769433290, field: "coreAction", value: "escape buddy", reason: "Owner review of review-1: chosen over \"find keys\".", decidedAt: "2026-10-29" }, // Oh, Buddy!
  { universeId: 10769466901, field: "template", value: "+1 {thing}", reason: "Owner review of review-1: chosen over \"+1 {action} for {reward}\".", decidedAt: "2026-10-29" }, // +1 Clap to DESTROY
  { universeId: 10769466901, field: "coreAction", value: "clap", reason: "Owner review of review-1: chosen over \"clap shockwaves\".", decidedAt: "2026-10-29" }, // +1 Clap to DESTROY
  { universeId: 10769484703, field: "rewardLoop", value: "none", reason: "Owner review of review-2: chosen over \"progress\".", decidedAt: "2026-10-29" }, // What If Disasters
  { universeId: 10769514597, field: "rewardLoop", value: "cosmetics", reason: "Owner review of review-2: chosen over \"none\".", decidedAt: "2026-10-29" }, // Makeup Salon
  { universeId: 10769532195, field: "family", value: "simulator", reason: "Owner review of review-2: chosen over \"RNG\".", decidedAt: "2026-10-29" }, // Lucky Animals Simulator
  { universeId: 10769542869, field: "family", value: "other", reason: "Owner review of review-1: chosen over \"driving\".", decidedAt: "2026-10-29" }, // Build and Drive
  { universeId: 10769542869, field: "coreAction", value: "build and drive", reason: "Owner review of review-1: chosen over \"build ramps\".", decidedAt: "2026-10-29" }, // Build and Drive
  { universeId: 10769616178, field: "coreAction", value: "pass driving test", reason: "Owner review of review-1: chosen over \"pass driving tests\".", decidedAt: "2026-10-29" }, // Get Your Driving License!
  { universeId: 10769634720, field: "coreAction", value: "survive pinkie pie", reason: "Owner review of review-1: chosen over \"survive pinkie\".", decidedAt: "2026-10-29" }, // PINKIE PROMISE
  { universeId: 10769712810, field: "coreAction", value: "roll looks", reason: "Owner review of review-1: chosen over \"transform looks\".", decidedAt: "2026-10-29" }, // Your New Look
  { universeId: 10769716380, field: "family", value: "{verb} a {thing}", reason: "Owner review of review-2: chosen over \"RNG\".", decidedAt: "2026-10-29" }, // Extract Your Tooth!
  { universeId: 10769716380, field: "rewardLoop", value: "rarity rolls", reason: "Owner review of review-2: chosen over \"collectibles\".", decidedAt: "2026-10-29" }, // Extract Your Tooth!
  { universeId: 10769787444, field: "family", value: "survival", reason: "Owner review of review-1: chosen over \"sandbox building\".", decidedAt: "2026-10-29" }, // ABOVE
  { universeId: 10769787444, field: "coreAction", value: "build auto farms", reason: "Owner review of review-1: chosen over \"craft items\".", decidedAt: "2026-10-29" }, // ABOVE
  { universeId: 10769851460, field: "rewardLoop", value: "money", reason: "Owner review of review-1: chosen over \"loot\".", decidedAt: "2026-10-29" }, // Criminal Simulator
  { universeId: 10769874587, field: "family", value: "modded copy", reason: "Owner review of review-1: corrected from \"{verb} a {thing}\".", decidedAt: "2026-10-29" }, // TAKE AN EGG! INFs OWNER EDITION
  { universeId: 10770370806, field: "template", value: "Find the {thing}", reason: "Owner review of review-1: chosen over \"{verb} the {thing}\".", decidedAt: "2026-10-29" }, // Find The Country
  { universeId: 10770370806, field: "rewardLoop", value: "none", reason: "Owner review of review-1: chosen over \"money\".", decidedAt: "2026-10-29" }, // Find The Country
  { universeId: 10770509911, field: "template", value: "{thing} Prison Run", reason: "Owner review of review-1: chosen over \"none\".", decidedAt: "2026-10-29" }, // BUDDY PRISON RUN! (Obby)
  { universeId: 10770509911, field: "coreAction", value: "run obstacle course", reason: "Owner review of review-1: chosen over \"complete stages\".", decidedAt: "2026-10-29" }, // BUDDY PRISON RUN! (Obby)
  { universeId: 10770615918, field: "family", value: "other", reason: "Owner review of review-1: chosen over \"shooter\".", decidedAt: "2026-10-29" }, // Get Your Gun's License!
  { universeId: 10770784203, field: "family", value: "simulator", reason: "Owner review of review-1: chosen over \"destruction\".", decidedAt: "2026-10-29" }, // Drain All Life
  { universeId: 10770784203, field: "rewardLoop", value: "stats", reason: "Owner review of review-1: chosen over \"money\".", decidedAt: "2026-10-29" }, // Drain All Life
  { universeId: 10770879065, field: "rewardLoop", value: "progress", reason: "Owner review of review-1: chosen over \"none\".", decidedAt: "2026-10-29" }, // It Hears The Water
  { universeId: 10770975616, field: "family", value: "simulator", reason: "Owner review of review-1: chosen over \"other\".", decidedAt: "2026-10-29" }, // HALLOWEEN HATCHERS 0.005
  { universeId: 10770975616, field: "template", value: "{thing} Hatchers", reason: "Owner review of review-1: chosen over \"none\".", decidedAt: "2026-10-29" }, // HALLOWEEN HATCHERS 0.005
  { universeId: 10771068210, field: "coreAction", value: "ride cart", reason: "Owner review of review-1: chosen over \"ride carts\".", decidedAt: "2026-10-29" }, // Paseo en carrito de panqueques obby
  { universeId: 10771421858, field: "coreAction", value: "avoid monster", reason: "Owner review of review-1: chosen over \"avoid splashing\".", decidedAt: "2026-10-29" }, // DONT SPLASH
  { universeId: 10771450807, field: "rewardLoop", value: "units", reason: "Owner review of review-1: chosen over \"progress\".", decidedAt: "2026-10-29" }, // WarFront
  { universeId: 10771509918, field: "template", value: "{thing} Simulator", reason: "Owner review of review-2: chosen over \"{hit} X{multiplier} MODDED\".", decidedAt: "2026-10-29" }, // Egg Farm Simulator
  { universeId: 10772372510, field: "family", value: "escape", reason: "Owner review of review-2: chosen over \"obby\".", decidedAt: "2026-10-29" }, // DON'T SPLASHMonster Escape
  { universeId: 10772415078, field: "rewardLoop", value: "none", reason: "Owner review of review-1: chosen over \"powers\".", decidedAt: "2026-10-29" }, // PANEL BUT ADMIN
];
