import { cp, mkdir, rm } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("../prebuilt/", import.meta.url), output, { recursive: true });
await cp(new URL("../bevy/assets/", import.meta.url), new URL("assets/", output), { recursive: true });
console.log("Prepared dist/ from prebuilt/ and bevy/assets/.");
