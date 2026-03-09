import { db } from "../index.js";
import { events } from "../schema.js";

async function main() {
    const allEvents = await db.select().from(events);
    console.log("Total Events:", allEvents.length);
    for (const e of allEvents) {
        console.log(`[${e.eventCode}] ${e.eventName}`);
    }
    process.exit(0);
}

main().catch(console.error);
