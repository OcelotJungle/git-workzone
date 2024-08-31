import { Console } from "console";

export class Logger extends Console {
    constructor(protected readonly verbose: boolean) {
        super(
            process.stdout,
            process.stderr,
            false,
        );
    }

    override debug(...args: any[]) {
        if (this.verbose) super.debug(...args);
    }

    override error(...args: any[]) {
        if (args[0] instanceof Error) {
            if (this.verbose) super.error(args[0]);
            else super.error(args[0].message);
        }
        else super.error(...args);
    }
}
