#!/usr/bin/env node

import { program } from "commander";
import * as cmd from "./commands.ts";
import * as utils from "./utils.ts";

// override default messages.
program.helpCommand("help", "Show this help.");
program.helpOption("-?, --help", "Show this help.");
program.configureHelp({ showGlobalOptions: true });
program.configureOutput({
	outputError: (str, write) => { write(utils.fixSentence(str)); },
});

program.description("Dowonload a Kakuyomu work for personal local use.");

// define common arguments and options.
const args = (key: string): [string, string] => {
	const map: Record<string, [string, string]> = {
		url: [ "<URL>", "URL, ID or filename of a Kakuyomu work." ],
		epid: [ "[ID]", `Render a single episode with the \
specified ID or 1-based index. If omitted, all episodes are processed \
and --output is assumed as a directory path.` ],
	};
	return map[key] ?? [ "", "" ];
};
const options = (ch: string): [ string, string ] => {
	const map: Record<string, [ string, string ]> = {
		od: [ "-o, --output <DIR>", "Specify the output directory." ],
		op: [ "-o, --output <PATH>", `Specify the output path. \
If it represents a directory, default filename will be appended.` ],
		f: [ "-f, --force", `Force proceed without prompts. \
Existing files will be overwritten unless --skip-existing is given.` ],
		k: [ "-k, --skip-existing", "Skip existing files when saving." ],
		t: [ "-t, --template <FILE>",
			`Use Mustache template file to render the output. \
If not specified, default builtin template will be used.` ],
	};
	return map[ch] ?? [ `-${ch}`, "" ];
};

// global argument(s) and options.
program.argument("args")
	.option("-v, --verbose", "Display verbose messages.", false)
	.on("option:verbose", (() => {
			process.env.VERBOSE = "1";
			utils.debug("Running in verbose mode.");
		}));

// info command.
program.command("info")
	.description("Display information about the given Kakuyomu work.")
	.argument(...args("url"))
	.action(cmd.onInfo);

// epubify command.
program.command("epubify")
	.alias("epub")
	.description(`Construct the epub directory structure and generates \
draft source files for a Kakuyomu work. Note that this command only \
generates draft files, which should be reviewed and edited manually to \
create a valid epub file.`)
	.argument(...args("url"))
	.option(`-u, --uuid <UUID>", "Specify the UUID for the book. \
If not specified, a new UUID will be generated.`)
	.option(...options("od"))
	.option(...options("f"))
	.option(...options("k"))
	.action(cmd.onEpubify);

// download commands.
program.command("download")
	.description(`Download raw HTML files from a Kakuyomu work. \
Output files are automatically named using sequential numbers. \
Episodes and cover image (if any) are downloaded from the Kakuyomu website \
even if URL parameter points to a local file.`)
	.argument(...args("url"))
	.option(...options("od"))
	.option(...options("f"))
	.option(...options("k"))
	.action(cmd.onDownload);

program.command("download-episodes")
	.description(`Download one or all episode pages. \
If ID is omitted, all episodes will be saved as files in the output \
directory (or current directory by default). \
if ID is given and --output is omitted, the content will be written to \
stdout.`)
	.argument(...args("url"))
	.argument(...args("epid"))
	.option(...options("op"))
	.option(...options("f"))
	.option(...options("k"))
	.action(cmd.onRenderEpisodes);

program.command("download-cover")
	.description(`Download the cover image if any. If --output is not \
given, the binary data will be written to stdout. Otherwise the source \
format may be converted to match the filename suffix. \
If both --width and --height are specified, the larger-scaling one will \
take effect to keep the aspect ratio.`)
	.argument(...args("url"))
	.option(...options("op"))
	.option(...options("f"))
	.option(...options("k"))
	.option("-h, --height <NUM>", `Resize the image to the given height. \
If 0 is passed, the height is enlarged to at least 1600px \
only if smaller.`)
	.option("-w, --width <NUM>", `Resize the image to the given width. \
If 0 is passed, the width is enlarged to at least 1000px \
only if smaller.`)
	.action(cmd.onDownloadCover);

// rendering commands, mainly for testing purposes.
program.command("render-work")
	.alias("work")
	.description(`Render the work information using a template. \
Without --template, the raw HTML will be written out. Note that \
the output may not be the same as 'epubify' command, for example \
UUID will be missing.`)
	.argument(...args("url"))
	.option(...options("op"))
	.option(...options("f"))
	.option(...options("k"))
	.option(...options("t"))
	.action(cmd.onRenderWork);

program.command("render-episodes")
	.alias("episodes")
	.description(`Render one or all episode pages. \
Without --template, the raw HTML will be written out.`)
	.argument(...args("url"))
	.argument(...args("epid"))
	.option(...options("op"))
	.option(...options("f"))
	.option(...options("k"))
	.option(...options("t"))
	.action(cmd.onRenderEpisodes);

program.command("render-cover")
	.description(`Render a cover page using the given image file.`)
	.argument("<URL>", `URL, ID or filename of a Kakuyomu work. \
If it ends with an image file extension such as '.jpg', it's assumed as \
a direct URL or path to the image and rendered without work definition.`)
	.option(...options("op"))
	.option(...options("f"))
	.option(...options("k"))
	.option(...options("t"))
	.action(cmd.onRenderCover);

// run.
try {
	await program.parseAsync();
	process.exitCode = 0;
} catch (e) {
	if (typeof e === "number") {
		// command may throw exit code when cancelled on prompt.
		process.exitCode = e;
	} else {
		utils.error(e);
		process.exitCode = 1;
	}
} finally {
	utils.debug(`Program ends with exit code ${process.exitCode}.`);
}
