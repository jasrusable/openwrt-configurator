// Imported for its side effect by the Node entry point and by ava's `require`.
import { setPlatform } from "../platform";
import { nodePlatform } from "./node";

setPlatform(nodePlatform);
