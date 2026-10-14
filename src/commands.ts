import * as NodePath from "node:path";
import * as UUID from "uuid";
import Mustache from "mustache";

import KkymWork from "./kkymwork.ts";
import * as epub from "./epub.ts";
import * as utils from "./utils.ts";

async function warnMissingData(prompt?: boolean): Promise<void>
{
	const warn = "Some of the author/chapter/episode data are missing.";
	if (prompt) {
		const answer = await utils.readChar(`${warn} Proceed anyway? (y/n): `,
				"yn");
		if (answer !== "y") throw 1;
	} else {
		utils.warn(warn);
	}
}

async function ensureFilePath(path: string,
		defname: string, force?: boolean): Promise<string>
{
	if (path === "" || utils.isDir(path)) {
		return NodePath.join(path, defname);
	}

	let dir = path;
	if (path.match(/[\\\/]$/)) {
		path = NodePath.join(path, defname);
	} else {
		dir = NodePath.dirname(path);
	}
	if (!await utils.ensureDir(dir, force)) {
		// aborted by user.
		throw 1;
	}
	return path;
}

async function renderEpisodes(url: string,
		download: boolean = false,
		options: Record<string, any>): Promise<void>
{
	console.info("Saving episodes...");

	let dir: string = options.output ?? "";
	let pattern = (options.template ? "{{sequentialNumber}}" : "{{id}}")
			+ ".html";
	if (dir !== "") {
		const file = NodePath.basename(dir);
		if (file.match(/\{\{[^{}\\\/?*<>]+\}\}/)) {
			// mustache filename pattern accepted.
			pattern = file;
			dir = NodePath.dirname(dir);
		}
		if (!await utils.ensureDir(dir, options.force)) throw 1;
	}
	utils.debug("Output directory:", dir);
	utils.debug("Output filenamae:", pattern);

	const work = new KkymWork();
	if (!await work.load(url)) {
		await warnMissingData(true);
	}
	if (download) {
		work.fetchEpisodes = true;
	}
	await work.renderEpisodes(options.template ?? null,
			dir, pattern,
			options.skipExisting ? false : options.force,
			console.info);
}

async function renderEpisode(url: string, id: string,
		download: boolean = false,
		options: Record<string, any>): Promise<void>
{
	utils.debug("Rendering episode:", id);

	let file = options.output;
	if (file !== undefined) {
		file = await ensureFilePath(file, "{{sequentialNumber}}.html",
				options.force);
		utils.debug("Output filename:", file);
	}

	const work = new KkymWork();
	if (!await work.load(url)) {
		await warnMissingData(false);
	}
	if (download) {
		work.fetchEpisodes = true;
	}

	// if id is between 1 and episode count, assume it as an index.
	const num = Number(id);
	if (!await work.renderEpisode(options.template ?? null,
			(0 < num && num <= work.publicEpisodeCount) ? num : id,
			file,
			options.skipExisting ? false : options.force)) {
		throw 1;
	}
}

/// Info Command

/**
 * Displays information about a Kakuyomu work. May be used to check if
 * the work can be loaded and parsed successfully.
 **/
export async function onInfo(url: string): Promise<void>
{
	const work = new KkymWork();
	if (!await work.load(url)) {
		await warnMissingData(false);
	}

	// show metadata fields.
	const view = work.makeWorkView();
	console.log("--- Kakuyomu Work Metadata ---");
	for (const key in view) {
		if (!["chapters", "episodes"].includes(key)) {
			console.log(`${key}:`, view[key]);
		}
	}

	// list chapters and episodes.
	const template = `--- Table of Contents ---
{{#chapters}}{{title}}
{{#episodes}}
  {{title}}  ({{localeStrings.publishedAt.date}}{{localeStrings.publishedAt.time}})
{{/episodes}}
{{/chapters}}
{{#episodes}}
{{title}}  ({{localeStrings.publishedAt.date}}{{localeStrings.publishedAt.time}})
{{/episodes}}`;
	console.log(Mustache.render(template, view).trim());

	// success.
	process.exitCode = 0;
}

/// EPUBify Command

export async function onEpubify(url: string,
		options: Record<string, any>): Promise<void>
{
	const work: KkymWork = new KkymWork();
	if (!await work.load(url)) {
		await warnMissingData(true);
	}
	const dir = options.output ?? "";
	if (dir !== "") {
		if (!await utils.ensureDir(dir, options.force)) throw 1;
	}
	let uuid = options.uuid;
	if (uuid === undefined) {
		uuid = UUID.v7();
		utils.debug("Using newly generated UUID:", uuid);
	}
	await epub.epubify(work, dir, uuid, options.force, options.skipExisting);
}

/// Download Commands

/**
 * Downloads the work, episode and cover files from the Kakuyomu website.
 **/
export async function onDownload(url: string,
		options: Record<string, any>): Promise<void>
{
	utils.debug(`Command options:`, options);

	const work: KkymWork = new KkymWork();
	if (!await work.load(url)) {
		await warnMissingData(true);
	}

	// ensure the output directory exists.
	const dir: string = options.output ?? "";
	if (dir !== "") {
		if (!await utils.ensureDir(dir, options.force)) throw 1;
	}

	const overwrite = options.skipExisting ? false : options.force;
	let file: string;
	let saved = 0, skipped = 0, failed = 0;

	// save the work page.
	console.info("Saving work:", work.id);
	file = NodePath.join(dir, `${work.id}.html`);
	try {
		if (await work.renderWork(file, overwrite)) {
			console.info("Saved:", file);
			saved++;
		} else {
			console.info("Skipped:", file);
			skipped++;
		}
	} catch (e) {
		utils.warn(e);
		failed++;
	}

	// save the episode files.
	console.info("Saving episodes...");
	work.fetchEpisodes = true;
	try {
		const result: number[] = await work.renderEpisodes(null,
				dir, "{{id}}.html", overwrite, console.info);
		saved += result[0] ?? 0;
		skipped += result[1] ?? 0;
		failed += result[2] ?? 0;
	} catch (e) {
		utils.warn(e);
	}

	// save cover image if any, without converting the format.
	if (work.coverUrl) {
		console.info("Saving cover image:", work.coverUrl);
		work.fetchCover = true;
		file = NodePath.join(dir, NodePath.basename(work.coverUrl));
		try {
			if (await work.saveCover(file, undefined, overwrite)) {
				console.info("Saved:", file);
				saved++;
			} else {
				console.info("Skipped:", file);
				skipped++;
			}
		} catch (e) {
			utils.warn(e);
			failed++;
		}
	}

	console.info(`Total file saved ${saved}, skipped ${skipped}, failed: ${failed}.`);
}

export async function onDownloadEpisodes(url: string, id: string,
		options: Record<string, any>): Promise<void>
{
	if (id === undefined) {
		await renderEpisodes(url, true, options);
	} else {
		await renderEpisode(url, id, true, options);
	}
}

export async function onDownloadCover(url: string,
		options: Record<string, any>): Promise<void>
{
	utils.debug("Command options:", options);

	const work: KkymWork = new KkymWork();
	if (!await work.load(url)) {
		await warnMissingData(false);
	}
	if (!work.coverUrl) {
		throw new Error("Work does not have a cover image.");
	}

	console.info("Downloading cover image:", work.coverUrl);
	let file = options.output;
	let format;

	if (file !== undefined) {
		file = await ensureFilePath(file,
				NodePath.basename(work.coverUrl),
				options.force);
		utils.debug("Output filename:", file);
		format = NodePath.extname(file);
		if (format !== "") {
			format = format.slice(1);
			if (format === "jpg") format = "jpeg";
		} else {
			format = undefined;
		}
	}

	work.fetchCover = true;
	await work.saveCover(file, format,
			options.skipExisting ? false : options.force);
}

/// Rendering Commands

export async function onRenderWork(url: string,
		options: Record<string, any>): Promise<void>
{
	const work: KkymWork = new KkymWork();
	if (!await work.load(url)) {
		await warnMissingData(false);
	}
	let file = options.output;
	if (file !== undefined) {
		file = await ensureFilePath(file, "{{id}}.html", options.force);
		utils.debug("Output filename:", file);
	}
	await work.renderWork(file, options.force,
			options.template ?? epub.templatePath("intro.html"));
}

export async function onRenderEpisodes(url: string, id: string,
		options: Record<string, any>): Promise<void>
{
	if (!options.template) {
		options.template = epub.templatePath("episode.html");
	}
	if (id === undefined) {
		await renderEpisodes(url, false, options);
	} else {
		await renderEpisode(url, id, false, options);
	}
}

export async function onRenderCover(url: string,
		options: Record<string, any>): Promise<void>
{
	const work: KkymWork = new KkymWork();
	if (url.match(/\.(jpe?g|png|gif|webp|bmp)$/i)) {
		work.coverUrl = url;
	} else if (!await work.load(url)) {
		await warnMissingData(false);
	}
	let file = options.output;
	if (file !== undefined) {
		file = await ensureFilePath(file, "cover.xhtml", options.force);
		utils.debug("Output filename:", file);
	}
	await epub.renderCover(work, file,
			options.skipExisting ? false : options.force,
			options.template);
}
