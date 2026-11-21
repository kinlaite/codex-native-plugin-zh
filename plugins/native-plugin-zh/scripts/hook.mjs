#!/usr/bin/env node
import { hookMain } from "../lib/hooks.mjs";

const event = process.argv[2] || "";
hookMain(event).finally(() => process.exit(0));
