#!/usr/bin/env node
import { guardMain } from "../lib/guard.mjs";

guardMain().finally(() => process.exit(0));
