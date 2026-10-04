import { mongoWatch } from "./mongo-watch.js";

const [uri, database, id, phase] = process.argv.slice(2);
const fixture = await mongoWatch(uri, database, id, phase);
await fixture.watch.activate();
await fixture.watch.poll();
await fixture.watch.flush();
throw new Error("Crash worker did not reach requested checkpoint");
