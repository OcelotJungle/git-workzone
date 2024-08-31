import { exec as callbackExec } from "child_process";
import { promisify } from "util";

export const exec = promisify(callbackExec);
