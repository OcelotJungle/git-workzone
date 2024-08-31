import fs from "fs";
import path from "path";

export class Config {
    protected readonly path: string;
    protected config: Record<string, string> = {};

    constructor(dir: string, name: string) {
        this.path = path.join(dir, name);
    }

    load() {
        try {
            const exists = fs.existsSync(this.path);

            console.debug(this.path, exists);

            if (exists) {
                this.config = JSON.parse(
                    fs.readFileSync(
                        this.path,
                        "utf-8",
                    ),
                );
            }
        }
        catch (e) {
            console.debug(e);

            this.save();
        }

        return this;
    }

    save() {
        console.debug("save", this.config);

        fs.mkdirSync(path.dirname(this.path), { recursive: true });
        fs.writeFileSync(this.path, JSON.stringify(this.config, null, 4));

        return this;
    }

    get(name: string) {
        console.debug("get", { name });

        if (name in this.config) {
            return String(this.config[name]);
        }

        return undefined;
    }

    getAll(): readonly [name: string, value: string][] {
        return Object
            .entries(this.config)
            .map(([name, value]) => [name, String(value)]);
    }

    set(name: string, value: string) {
        console.debug("set", { name, value });

        this.config[name] = String(value);

        return this;
    }

    remove(name: string) {
        console.debug("remove", { name });

        delete this.config[name];

        return this;
    }
}
