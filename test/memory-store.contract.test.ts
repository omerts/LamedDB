import { MemoryStore } from "../src/index.js";

import { runStoreContract } from "./store-contract.js";

runStoreContract("MemoryStore", (options) => new MemoryStore(options));
