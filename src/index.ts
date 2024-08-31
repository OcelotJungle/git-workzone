import fs from "fs";
import path from "path";
import util from "util";
import ospath from "ospath";
import { simpleGit } from "simple-git";
import { Command } from "commander";
import {
    exec,
    Logger,
    Config,
    ConcurrentRunner,
} from "./utils";

const WORKZONES_DIR_NAME = ".workzones";

const cwd = process.cwd();
const workzonesRoot = path.join(cwd, WORKZONES_DIR_NAME);

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const programArgv = argv.filter(arg => arg !== "--verbose");

global.console = new Logger(verbose);

const globalConfig = new Config(ospath.data(), ".git-workzone.config.json").load();
const localConfig = new Config(workzonesRoot, "config.json").load();
const config = {
    get(name: string) {
        return localConfig.get(name) ?? globalConfig.get(name);
    }
};

console.debug({ argv, cwd, workzonesRoot });

function normalizeWorkzoneFolder(name: string) {
    return name
        .replaceAll("\\", "_")
        .replaceAll("/", "_");
}

const program = new Command()
    .name("git-workzone")
    .description("Helper tool to manage jointed Git Worktrees")
    .version("1.0.0");

// Config
{
    const configCommand = program
        .command("config")
        .description("Config actions");

    configCommand
        .command("get")
        .argument("[name]")
        .option("--global", "Search for only global config (high priority)", false)
        .option("--local", "Search for only local config (low priority)", false)
        .action((
            name: string | undefined,
            options: { global: boolean, local: boolean },
        ) => {
            console.debug({ name, options });

            if (name) {
                let value;

                if (options.global) value = globalConfig.get(name);
                else if (options.local) value = localConfig.get(name);
                else value = config.get(name);

                console.log(value);

                return;
            }

            let list: readonly [string, string][];

            if (options.global) list = globalConfig.getAll();
            else if (options.local) list = localConfig.getAll();
            else {
                list = Object.entries(
                    Object.fromEntries([
                        ...globalConfig.getAll(),
                        ...localConfig.getAll(),
                    ])
                );
            }

            console.log(list);
        });

    configCommand
        .command("set")
        .argument("<name>")
        .argument("<value>")
        .option("--global", "Set in global config", false)
        .action((
            name: string,
            value: string,
            options: { global: boolean },
        ) => {
            if (options.global) {
                globalConfig
                    .set(name, value)
                    .save();
            }
            else {
                localConfig
                    .set(name, value)
                    .save();
            }
        });

    configCommand
        .command("remove")
        .argument("<name>")
        .option("--global", undefined, false)
        .action((
            name: string,
            options: { global?: boolean },
        ) => {
            if (options.global) {
                globalConfig
                    .remove(name)
                    .save();
            }
            else {
                localConfig
                    .remove(name)
                    .save();
            }
        });
}

program
    .command("list")
    .action(() => {
        const dir = path.join(cwd, WORKZONES_DIR_NAME);

        const list = [];

        if (fs.existsSync(dir)) {
            const workzones = fs.readdirSync(dir);

            for (const workzone of workzones) {
                if (fs.existsSync(path.join(dir, workzone, "workzone.json"))) {
                    list.push(workzone);
                }
            }
        }

        console.log(list);
    })

program
    .command("open")
    .argument("<name>")
    .option("-c, --command [command]")
    .option("-vscw, --open-vscode-workspace", undefined, false)
    .action((
        name: string,
        options: { command?: string, openVscodeWorkspace: boolean },
    ) => {
        const workzoneFolder = normalizeWorkzoneFolder(name);
        const dir = path.join(cwd, WORKZONES_DIR_NAME);

        if (!fs.existsSync(dir)) {
            console.error(`Workzone '${name}' does not exist here.`);
            return;
        }

        const workzones = fs.readdirSync(dir);

        if (!workzones.includes(workzoneFolder)) {
            console.error(`Workzone '${name}' does not exist here.`);
            return;
        }

        const openCommand = options.command ?? config.get("open-command");
        if (openCommand === undefined) {
            console.error("No open command configured.");
            console.error("Set config value 'open-command' or use option --command.");
            return;
        }

        if (
            options.openVscodeWorkspace
            || config.get("open-vscode-workspace") === "true"
            || config.get("use-vscode-workspace") === "true"
        ) {
            const workspacePath = path.join(
                dir,
                workzoneFolder,
                `${workzoneFolder}.code-workspace`,
            );

            if (fs.existsSync(workspacePath)) {
                exec(`${openCommand} ${workspacePath}`);
                return;
            }
        }

        exec(`${openCommand} ${path.join(dir, workzoneFolder)}`);
    })

type CreateOptions = {
    branch?: string;
    force: boolean;
    concurrent: string;
    createVscodeWorkspace: boolean;
    copyItems?: string;
    afterCopyCommand?: string;
};

program
    .command("create")
    .argument("<name>")
    .option("-b, --branch <new-branch-name>")
    .option("-f, --force", "Rewrites branch if it already exists", false)
    .option("-c, --concurrent [max]", "Concurrently run sets of actions", "8")
    .option("-vscw, --create-vscode-workspace", undefined, false)
    .option("-ci, --copy-items [copy-items]", "Comma-separated list of files or directories to just copy")
    .option("-acc, --after-copy-command [command]", "Command to run inside created worktree directory")
    .action(async (
        name: string,
        options: CreateOptions,
        command: Command,
    ) => {
        const workzoneFolder = normalizeWorkzoneFolder(name);
        const branchName = options.branch ?? name;

        const force = Boolean(options.force);

        const args = command.args.slice(1);

        const concurrent = ((string) => {
            const number = +string;
            return Number.isNaN(number) ? 1 : number;
        })(options.concurrent);

        console.debug("create", {
            name,
            options,
            workzoneFolder,
            branchName,
            force,
            concurrent,
        });

        const folders: string[] = [];
        const branches: Record<string, string> = {};

        for (const arg of args) {
            const [folder, branch] = arg.split("=") as [string, string?];

            folders.push(folder);
            if (branch) branches[folder] = branch;
        }

        try {
            console.debug("started hydrating branches", { branches });

            await ConcurrentRunner.run(
                folders.map(folder => async () => {
                    console.debug("look for branch", { folder });

                    const dir = path.join(cwd, folder);

                    // Check if directory exists
                    if (!fs.existsSync(dir)) {
                        throw new Error(`Directory '${folder}' does not exist here.`);
                    }

                    // Check if git repository
                    const result = await simpleGit(dir).branch();

                    const gitBranches = result.all;
                    const current = result.current;

                    let branch = current;

                    // Check if branch exists
                    if (folder in branches) {
                        branch = branches[folder]!;

                        if (!gitBranches.includes(branch)) {
                            throw new Error([
                                `Branch '${branch}' does not exist in directory '${folder}'.`,
                                "Available branches:",
                                util.inspect(gitBranches, { colors: true }),
                            ].join("\n"));
                        }
                    }

                    if (!force && gitBranches.includes(branchName)) {
                        throw new Error(`Branch '${branchName}' already exists in directory '${folder}'.`);
                    }

                    console.debug("branch found", { folder, branch });
                    branches[folder] = branch;
                }),
                concurrent,
            );

            console.debug("hydrating branches done", { branches });
        }
        catch (e) {
            console.error(e);
            return;
        }

        const workzonesDir = path.join(cwd, WORKZONES_DIR_NAME, workzoneFolder);

        fs.mkdirSync(workzonesDir, { recursive: true });

        const entries = [{ path: "workzone.json" }];

        if (
            options.createVscodeWorkspace
            || config.get("create-vscode-workspace") === "true"
            || config.get("use-vscode-workspace") === "true"
        ) {
            fs.writeFileSync(
                path.join(workzonesDir, `${workzoneFolder}.code-workspace`),
                JSON.stringify({
                    folders: folders.map(folder => ({
                        path: folder,
                        name: folder,
                    })),
                    settings: {},
                }, null, 4),
            )

            entries.push({ path: `${workzoneFolder}.code-workspace` });
        }

        const copyItems = (
            (string: string | undefined) => {
                if (!string) return [];
                if (string.length === 0) return [];

                return string.split(",");
            }
        )(options.copyItems ?? config.get("copy-items"));

        const afterCopyCommand = options.afterCopyCommand ?? config.get("after-copy-command");

        try {
            console.debug("branches", branches);

            await ConcurrentRunner.run(
                Object
                    .entries(branches)
                    .map(([folder, branch]) => async () => {
                        console.debug("started exec", { folder, branch });

                        const dir = path.join(cwd, folder);
                        const workzoneMemberDir = path.join(workzonesDir, folder);

                        await exec(
                            `git worktree add -f -B "${branchName}" "${workzoneMemberDir}" "${branch}"`,
                            { cwd: dir },
                        );

                        for (const copyItem of copyItems) {
                            if (fs.existsSync(path.join(dir, copyItem))) {
                                console.debug("copy", { folder, copyItem });
                                await fs.promises.cp(
                                    path.join(dir, copyItem),
                                    path.join(workzoneMemberDir, copyItem),
                                    { recursive: true, force: true, dereference: true },
                                );
                            }
                        }

                        if (afterCopyCommand) {
                            const start = Date.now();
                            console.debug("exec after copy command", { folder, afterCopyCommand });
                            await exec(afterCopyCommand, { cwd: workzoneMemberDir });
                            console.debug("exec after copy command duration", { duration: Date.now() - start });
                        }
                    }),
                concurrent,
            );
        }
        catch (e) {
            console.error(e);
            return;
        }

        fs.writeFileSync(
            path.join(workzonesDir, "workzone.json"),
            JSON.stringify({
                members: Object
                    .entries(branches)
                    .map(([folder, branch]) => ({
                        name: folder,
                        folder: path.join(cwd, folder),
                        branch: branchName,
                        sourceBranch: branch,
                    })),
                entries,
            }, null, 4),
        );
    });

type WorkzoneConfig = {
    members: {
        name: string;
        folder: string;
        branch: string;
        sourceBranch: string;
    }[];

    entries: {
        path: string;
    }[];
};

program
    .command("delete")
    .argument("<name>")
    .option("-pb, --preserve-branches", "Do not delete branches too", false)
    .option("-a, --hard", "Delete all directories inside workzone directory, not only worktrees", false)
    .action(async (
        name: string,
        options: { preserveBranches: boolean, hard: boolean },
    ) => {
        const workzoneFolder = normalizeWorkzoneFolder(name);
        const dir = path.join(cwd, WORKZONES_DIR_NAME);

        if (!fs.existsSync(dir)) {
            console.error(`Workzone '${name}' does not exist here.`);
            return;
        }

        const workzones = fs.readdirSync(dir);

        if (!workzones.includes(workzoneFolder)) {
            console.error(`Workzone '${name}' does not exist here.`);
            return;
        }

        const workzoneDir = path.join(dir, workzoneFolder);

        if (!fs.existsSync(path.join(workzoneDir, "workzone.json"))) {
            console.error(`Directory '${workzoneFolder}' does exist in workzones, but it is not a workzone itself.`);
            return;
        }

        const workzone: WorkzoneConfig = JSON.parse(
            fs.readFileSync(
                path.join(workzoneDir, "workzone.json"),
                "utf-8",
            ),
        );

        const preserveBranches = Boolean(options.preserveBranches);

        for (const member of workzone.members) {
            const originalDir = member.folder;
            const workzoneMemberDir = path.join(workzoneDir, member.name);

            await exec(`git worktree remove -f ${workzoneMemberDir}`, { cwd: originalDir });
            fs.rmSync(workzoneMemberDir, { recursive: true, force: true });

            if (!preserveBranches) {
                await simpleGit(originalDir).deleteLocalBranch(member.branch, true);
            }
        }

        for (const entry of workzone.entries) {
            fs.rmSync(path.join(workzoneDir, entry.path), { recursive: true, force: true });
        }

        const hard = Boolean(options.hard);

        if (fs.readdirSync(workzoneDir).length > 0 && !hard) {
            console.error("Workzone directory contains items that are not part of workzone.");
            console.error("You can delete them manually.");
            return;
        }

        fs.rmSync(workzoneDir, { recursive: true, force: true });
    })

program.parseAsync(programArgv, { from: "user" });
