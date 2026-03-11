import fs from "fs";
import { db } from "../index.js";
import { backofficeUsers } from "../schema.js";
import { eq } from "drizzle-orm";

async function main() {
    const [admin] = await db.select().from(backofficeUsers).where(eq(backofficeUsers.email, "admin@accp.com")).limit(1);
    if (!admin) {
        console.error("Admin not found.");
        process.exit(1);
    }

    // Make API request with fake token
    const eventData = {
        eventCode: "API_TEST_" + Date.now().toString().slice(-4),
        eventName: "Test API Event",
        description: "Testing API",
        eventType: "single_room",
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 86400000).toISOString(),
        maxCapacity: 100,
        status: "draft",
    };

    console.log("Sending:", eventData);

    try {
        const res = await fetch("http://localhost:3002/api/backoffice/events", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
                // Note: The real API requires an Auth token.
                // It's possible the user's issue isn't a duplicate event, but rather a generic 409 from somewhere else.
                // We will need a token to test properly, or test the endpoint function directly.
            },
            body: JSON.stringify(eventData)
        });
        const data = await res.text();
        console.log(res.status, data);
    } catch (err) {
        console.error(err);
    }
}
main();
