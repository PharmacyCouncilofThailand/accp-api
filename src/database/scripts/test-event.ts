import "dotenv/config";
import { db } from "../index.js";
import { events } from "../schema.js";

async function main() {
    console.log("Inserting test event...");
    try {
        const [newEvent] = await db.insert(events).values({
            eventCode: "TEST2026",
            eventName: "Test Event",
            eventType: "single_room",
            startDate: new Date(),
            endDate: new Date(),
            maxCapacity: 100,
            status: "draft"
        }).returning();
        console.log("Success:", newEvent);
    } catch (error) {
        console.error("Failed:", error);
    }
    process.exit(0);
}

main().catch(console.error);
