import * as fs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import Mustache from "mustache";
import imageSize from "image-size";
import { imageSizeFromFile } from "image-size/fromFile";

import KkymWork, { type Metadata as KkymMetadata } from "./kkymwork.ts";
import * as utils from "./utils.ts";

/**
 * Returns the full path for a static file in src/assets.
 **/
function assetPath(file?: string): string
{
	const dir = NodePath.join(import.meta.dirname, "../assets");
	return (file === undefined) ? dir : NodePath.join(dir, file);
}

/**
 * Returns the full path for a Mustache template file in src/templates.
 **/
export function templatePath(file: string): string
{
	return NodePath.join(import.meta.dirname,
			"../assets/templates", `${file}.mustache`);
}

/**
 * Copies directory contents recursively.
 **/
async function copyTree(from: string, to: string,
		overwrite?: boolean): Promise<void>
{
	let entries;
	try {
		entries = await fs.promises.readdir(from, {
			withFileTypes: true,
			recursive: false
		});
	} catch (e) {
		utils.error("Unable to read directoroy:", from);
		throw e;
	}
	for (const ent of entries) {
		const src = NodePath.join(from, ent.name);
		const dest = NodePath.join(to, ent.name);
		if (ent.isDirectory()) {
			try {
				if (await utils.ensureDir(dest, true) === 2) {
					console.info("Created:", dest);
				}
			} catch (e) {
				utils.error("Failed to create directory:", dest);
				throw e;
			}
			await copyTree(src, dest, overwrite);
			continue;
		}
		if (await utils.checkOverwrite(dest, overwrite)) {
			try {
				await fs.promises.cp(src, dest, { force: true });
			} catch (e) {
				utils.error("Failed to copy file to:", dest);
				throw e;
			}
			console.info("Saved:", dest);
		} else {
			console.info("Skipped:", dest);
		}
	}
}

/**
 * Saves the cover image to the EPUB structure and returns an object
 * containing the image info to be used as a rendering view.
 **/
async function saveCoverImage(work: KkymWork, dir: string,
		overwrite?: boolean): Promise<Record<string, any>>
{
	let name = "cover";	// default filename
	let type = NodePath.extname(work.coverUrl).toLowerCase();
	if (type !== "") {
		type = type.slice(1);
		if ([ "jpg", "webp" ].includes(type)) {
			type = "jpeg";
			name += ".jpg";
		} else {
			name += `.${type}`;
		}
	}

	let file = NodePath.join(dir, name);
	let dim;

	// check if the cover image already exists.
	if (await utils.checkOverwrite(file, overwrite)) {
		// download the image.
		console.info("Saving cover image...");
		dim = await work.saveCover(file, type, true);
		if (!dim) {
			throw new Error("Unexpected error: KkymWork.downloadCover returned null.");
		}
		console.info("Saved:", file);
	} else {
		// use existing file.
		utils.debug("Reusing cover image:", file);
		try {
			dim = await imageSizeFromFile(file);
		} catch (e) {
			utils.debug(e);
			throw new Error(`Failed to get image size: ${file}`);
		}
		if (dim.type === "jpg") dim.type = "jpeg";
	}

	return {
		file: name,
		width: dim.width,
		height: dim.height,
		type: dim.type ?? type,
	};
}

/**
+- mimetype
+- META-INF/
   +- container.xml
+- OEBPS/
   +- intro.html
   +- toc.html
   +- c01e001.html
   +- c01e002.html
   +- c02e003.html
   +- ...
   +- kkym.css
+- content.opf
+- cover.xhtml
+- cover.jpg
+- nav.xhtml
+- toc.ncx
**/

interface EpubWorkView extends KkymMetadata {
	uuid: string;
	coverImage?: Record<string, any>;
}

const epubMetaFiles: { [key: string]: string } = {
	// epub fils at the root level.
	content: "content.opf",
	cover: "cover.xhtml",
	nav: "nav.xhtml",
	toc: "toc.ncx",
};
const epubContentFiles: { [key: string]: string } = {
	// epub content files in OEBPS/.
	intro: "intro.html",
	toc: "toc.html",
};
const epubContentDir = "OEBPS";

export async function epubify(work: KkymWork,
		dir: string,	// output directory must exist
		uuid: string,	// caller should take care of uuid
		force?: boolean, skipExisting?: boolean): Promise<void>
{
	if (uuid === "") uuid = "YOUR-UUID-HERE";
	const overwrite = skipExisting ? false : force;

	// first copy the static files to the output location.
	// this ensures the output directory structure.
	await copyTree(assetPath("epub"), dir, overwrite);

	// prepare the work renderng view.
	let view: EpubWorkView = {
		...work.makeWorkView(),
		uuid: uuid,
	}

	// adjust content orders so that they come after intro pages.
	for (const chapter of view.chapters ?? []) {
		chapter.order += 3;
		for (const episode of chapter.episodes) {
			episode.order += 3;
		}
	}
	for (const episode of view.episodes ?? []) {
		episode.order += 3;
	}

	// save the cover image if any.
	if (work.coverUrl) {
		view.coverImage = await saveCoverImage(work, dir, overwrite);
		utils.debug("view.coverImage:", view.coverImage);
	}

	// generate epub meta files.
	for (const key in epubMetaFiles) {
		const file = epubMetaFiles[key] ?? "";
		await renderContent(file, view, dir, file, overwrite);
	}

	// generate epub content files.
	const subdir = NodePath.join(dir, epubContentDir);
	for (const key in epubContentFiles) {
		const file = epubContentFiles[key] ?? "";
		await renderContent(file, view, subdir, file, overwrite);
	}

	await work.renderEpisodes(templatePath("episode.html"),
			subdir, "{{serialName}}.html", overwrite,
			console.info);
}

async function renderContent(template: string,
		view: Record<string, any>,
		dir: string, file: string, overwrite?: boolean): Promise<boolean>
{
	const dest = NodePath.join(dir, file);
	if (!await utils.checkOverwrite(dest, overwrite)) {
		console.log("Skipped:", dest);
		return false;
	}

	const asset = templatePath(template);
	let content;
	try {
		const tpl = await fs.promises.readFile(asset, "utf-8");
		content = Mustache.render(tpl, view);
	} catch (e) {
		utils.error("Unable to read template:", asset);
		throw e;
	}

	try {
		if (!await utils.writeFile(content, dest, true)) {
			utils.debug("Unexpected error: File not written:", dest);
			return false;
		}
	} catch (e) {
		utils.error("Failed to save file:", dest);
		throw e;
	}

	console.log("Saved:", dest);
	return true;
}

/**
 * Renders a cover page using the given image file and template.
 * @param url - URL or path to the cover image.
 * @param file - Output filename. If undefined, stdout will be used.
 * @param overwrite - If `true`, overwrites existing file.
 * @param template - Mustache template file.
 **/
export async function renderCover(work: KkymWork, file?: string,
		overwrite?: boolean, template?: string): Promise<boolean>
{
	if (template === undefined) {
		template = templatePath(epubMetaFiles.cover ?? "");
	}

	let view: Record<string, any> = work.id ? work.getMetadata() :
			{ coverUrl : work.coverUrl };

	if (work.coverUrl) {
		// has a cover image, determine the image size.
		let url = work.coverUrl;
		let dim;
		try {
			if (url.match(/^https?:/)) {
				utils.debug("Fetching image:", url);
				const response = await fetch(url);
				const data = await response.bytes();
				const image = Buffer.from(data);
				dim = imageSize(image);
			} else {
				if (url.match(/^file:/)) {
					url = fileURLToPath(url);
				}
				dim = await imageSizeFromFile(url);
			}
			if (dim.type === "jpg") dim.type = "jpeg";
			utils.debug("Cover image:", dim);
			view.coverImage = {
				file: NodePath.basename(url),
				...dim
			};
		} catch (e) {
			utils.error("Failed to read image:", url);
			throw e;
		}
	}

	// apply mustache template.
	let content;
	try {
		const tpl = await fs.promises.readFile(template, "utf-8");
		content = Mustache.render(tpl, view);
	} catch (e) {
		utils.debug("Failed to apply template:", template);
		throw e;
	}

	return await utils.writeFile(content, file, overwrite);
}
