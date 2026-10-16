import Assert from "node:assert";
import * as fs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import sharp, { type FormatEnum, type JpegOptions, type PngOptions } from "sharp";
import imageSize from "image-size";
import Mustache from "mustache";

import * as utils from "./utils.ts";

/// Helper Functions

const assert = (process.env.NODE_DEV === "production") ? () => {} : Assert;

/**
 * Returns a value at the specified key path.
 * @param obj - An object which contains key-value pairs.
 * @param path - Path of the value to retrieve. This is a string that
 * contains the keys chained by ".", like "key1.key2.key3".
 **/
function getByPath(obj: Record<string, any>, path: string): any
{
	let value = obj;
	const keys = path.split(".");
	for (const key of keys) {
		if (value == null || !(key in value)) {
			utils.debug("Property not found:", key, `(in "${path}")`);
			return undefined;
		}
		value = value[key];
	}
	return value;
}

/**
 * Returns an element with the given ID from HTML, string either as an
 * HTMLElement or as a JSON object.
 **/
function getHtmlElement(html: string, id: string, json: boolean = false)
		: HTMLElement | Record<string, unknown>
{
	let dom: JSDOM | null = new JSDOM(html);
	const elem = dom.window.document.getElementById(id);
	dom.window.close();
	dom = null;
	if (!elem) {
		throw new KkymError(`HTML element with id="${id}" was not found.`);
	}
	utils.debug(`Element found: <${elem.tagName} ` +
			Array.from(elem.attributes).map((attr) => {
				return `${attr.name}="${attr.value}"`;
			}).join(" ") + ">");
	return json ? JSON.parse(elem.innerHTML) : elem;
}

/**
 * Adds HTML tags to content text for better rendering.
 **/
function markupText(text: string): string | null
{
	let html = "";

	while (text !== "") {
		// look for ascii alphanumeric chars.
		const found = text.match(/[A-Za-z0-9]+/);
		if (!found) {
			if (html === "") return null;
			html += text;
			break;
		}
		assert(found.index !== undefined);
		const index = found.index ?? 0;
		const len = found[0].length;
		html += text.slice(0, index);
		text = text.slice(index + len);

		// if followed by more latin/ipa chars, ignore the entire sequence.
		const lat = text.match(/^(?:\s?[\u0021-\u02af]+)+/);
		if (!lat) {
			let cls = found[0].match(/^[0-9]+$/) ?  "digit" :
					found[0].match(/^[A-Za-z]+$/) ? "alpha" : "alnum";
			cls += ` ${cls}` + (len < 10) ? len.toString() : "x";
			html += `<span class="${cls}">${found[0]}</span>`;
		} else {
			html += found[0] + lat[0];
			text = text.slice(lat[0].length);
		}
	}

	return html;
}

function markupChild(child: ChildNode)
{
	switch (child.nodeType) {
		case 1:		// Node.ELEMENT_NODE
			if (child.hasChildNodes()) {
				const nodes = Array.from(child.childNodes);
				for (const node of nodes) {
					markupChild(node);
				}
			}
			break;
		case 3:		// Node.TEXT_NODE
			if (child.textContent) {
				let html = markupText(child.textContent);
				if (html != null && child.parentElement) {
					child.parentElement.innerHTML = html;
				}
			}
			break;
		default:
			// do nothing.
			break;
	}
}

/**
 * Converts image data into another format using sharp.
 **/
async function convertImageFormat(buffer: Buffer<ArrayBuffer>,
		format: string): Promise<Buffer<ArrayBuffer>>
{
	assert(format);
	let result: Buffer<ArrayBuffer>;
	let image;

	try {
		image = sharp(buffer);
	} catch (e) {
		utils.debug("Unable to load image.");
		throw e;
	}
	try {
		const meta = await image.metadata();
		if (meta.format === format) {
			utils.debug("No image conversion needed.");
			return buffer;
		}
		utils.debug("Source image:", meta.format);
	} catch (e) {
		utils.debug("Failed to determine image format.", e);
		// continue anyway.
	}

	utils.debug("Target image:", format);
	try {
		let options: JpegOptions | PngOptions = {};
		if (format === "jpeg") {
			options = { quality: 100 };
		} else if (format === "png") {
			options = { compressionLevel: 9, quality: 100 };
		}
		result = await image.toFormat(format as keyof FormatEnum, options)
				.toBuffer();
	} catch (e) {
		utils.debug("Failed to convert image format.");
		throw e;
	}

	return result;
}

function stripPromo(str: string): string
{
	type TitleStripFn = (str: string, re: RegExpMatchArray) => string;
	type TitleStripMap = { regexp: string, stripFn: TitleStripFn };
	const promo = "【[^】]*(書籍|コミカライズ|コミック|発売)[^】]*】";
	const maps: TitleStripMap[] = [
		{
			regexp: `^${promo}`,
			stripFn: (str, re) => str.slice(re[0].length)
		},
		{
			regexp: `${promo}$`,
			stripFn: (str, re) => str.slice(0, re.index ?? 0)
		},
	];
	for (const map of maps) {
		const rx = new RegExp(map.regexp);
		while (1) {
			const found = str.match(rx);
			if (!found) break;
			str = map.stripFn(str, found);
		}
	}
	return str;
}

/// Kakuyomu JSON Structures

interface jsonRef {
	__ref: string;
}

interface jsonToc {
	__typename: string;
	id: string;
	episodeUnions: jsonRef[];
	chapter: jsonRef;
}

interface jsonChapter {
	__typename: string;
	id: string;
	level: number;
	title: string;
}

interface jsonEpisode {
	__typename: string;
	id: string;
	title: string;
	publishedAt: string;
}

/// Interfaces

type LocaleDateTime = Record<"date" | "time", string>;

export interface Episode {
	id: string;
	title: string;
	titleFormatted: string;
	publishedAt: string;
	order: number;
	// chapter+episode name as c1e01, c1e02, c2e03, ...
	serialName: string;
	// chapter id and title, only in the first episode of a chapter.
	newChapter?: Record<"id" | "title" | "titleFormatted", string>;
	// formatted number/date/time strings.
	localeStrings?: Record<"publishedAt", LocaleDateTime>;
	// episode html content.
	content?: string;
}

export interface Chapter {
	id: string;
	level: number;
	title: string;
	titleFormatted: string;
	order: number;
	serialName: string;	// c1, c2, ...
	episodes: Episode[];
}

interface MetaLocaleStrings {
	genre: string;
	serialStatus: string;
	publicEpisodeCount: string;
	totalCharacterCount: string;
	publishedAt: LocaleDateTime;
	editedAt: LocaleDateTime;
}

type MetaLocaleStringKey = keyof MetaLocaleStrings;

export interface Metadata {
	[key: string]: any;
	id: string;
	title: string;
	author: string;
	baseColor: string;
	genre: string;
	catchphrase: string;
	introduction: string;
	isCruel: boolean;
	isViolent: boolean;
	isSexual: boolean;
	serialStatus: string;
	publicEpisodeCount: number;
	totalCharacterCount: number;
	publishedAt: string;
	editedAt: string;
	coverUrl: string;
	titleStripped?: string;
	localeStrings?: MetaLocaleStrings;
}

// for KkymClass implementation
export interface Work extends Metadata {
	// either chapters or episodes should exist in rendering view.
	// KkymWork class always has chapters but not episodes.
	chapters?: Chapter[];
	episodes?: Episode[];
	// title without promotional tokens, only in rendering view.
}

// locale strings
const localeNumber = (value: number): string => {
	return value.toLocaleString("ja-JP");
};
const localeDateTime = (value: string): LocaleDateTime => {
	const dt = new Date(value);
	return {
		date: dt.toLocaleDateString("ja-JP",
			{ year: "numeric", month: "long", day: "numeric" }),
		time: dt.toLocaleTimeString("ja-JP",
			{ hour: "2-digit", minute: "2-digit" }),
	};
};
const localeStringsMap: Record<MetaLocaleStringKey, any> = {
	genre: {
		"FANTASY": "異世界ファンタジー",
		"ACTION": "現代ファンタジー",
		"SF": "SF",
		"LOVE_STORY": "恋愛",
		"ROMANCE": "ラブコメ",
		"DRAMA": "現代ドラマ",
		"HORROR": "ホラー",
		"MYSTERY": "ミステリー",
		"NONFICTION": "エッセイ・ノンフィクション",
		"HISTORY": "歴史・時代・伝奇",
		"CRITICISM": "創作論・評論",
		"OTHERS": "詩・童話・その他",
		"MAHO": "魔法のiらんど",
		"FAN_FICTION": "二次創作"
	},
	serialStatus: {
		"COMPLETED": "完結済",
		"RUNNING": "連載中"
	},
	publicEpisodeCount: localeNumber,
	totalCharacterCount: localeNumber,
	publishedAt: localeDateTime,
	editedAt: localeDateTime,
};

/// Kkym Classes

// Wrapper class to represent a kkym error.
export class KkymError extends Error {}

/**
 * A class to represent a Kakuyomu work.
 **/
export default class KkymWork implements Work
{
	[key: string]: any;

	// Metadata fields.
	id: string = "";
	title: string = "";
	author: string = "";
	baseColor: string = "";
	genre: string = "";
	catchphrase: string = "";
	introduction: string = "";
	isCruel: boolean = false;
	isViolent: boolean = false;
	isSexual: boolean = false;
	serialStatus: string = "";
	publicEpisodeCount: number = 0;
	totalCharacterCount: number = 0;
	publishedAt: string = "";
	editedAt: string = "";
	coverUrl: string = "";
	// Work fields.
	chapters: Chapter[] = [];
	//episodes: Episode[] = [];

	// customization prop: force re-fetching from the web.
	fetchCover: boolean = false;
	fetchEpisodes: boolean = false;

	// internal fields.
	protected url: string = "";
	protected local: boolean = false;
	protected html: string = "";

	constructor()
	{
	}

	/**
	 * Loads information from a Kakuyomu work page.
	 * @param url - URL, ID or filename of a work. A numeric string is
	 * considered as an ID and converted to the corresponding URL on the
	 * Kakuyomu website.
	 * @returns true if successful. If the basic information is loaded
	 * but some of the author/chapter/episode values are missing, false
	 * is returned.
	 * @throws {KkymError} if the page is not in the expected format,
	 * or other parsing errors from JSDOM/JSON.
	 **/
	public async load(url: string): Promise<boolean>
	{
		assert(!this.id);

		if (url.match(/^[0-9]+$/)) {
			this.url = `https://kakuyomu.jp/works/${url}`;
			this.local = false;
		} else if (url.match(/^https?/)) {
			this.url = url;
			this.local = false;
		} else if (url.match(/^file:/)) {
			this.url = fileURLToPath(url);
			this.local = true;
		} else {
			this.url = fs.realpathSync(url);
			this.local = true;
		}

		let err = 0;
		let apollo, work;

		const getValue = (obj: Record<string, any>, path: string, fatal?: boolean)
				: any => {
			if (path === "") {
				utils.debug("Property path is empty.");
				return undefined;
			}
			const value = getByPath(obj, path);
			if (value === undefined) {
				err++;
				if (fatal) {
					throw new KkymError("Unexpected source JSON structure.");
				}
			}
			return value;
		};

		// get to the necessary objects in source json.
		try {
			if (this.local) {
				utils.debug("Reading local file:", this.url);
				this.html = await fs.promises.readFile(this.url, "utf-8");
			} else {
				utils.debug("Fetching URL:", this.url);
				const response = await fetch(this.url);
				this.html = await response.text();
			}
			const json = getHtmlElement(this.html, "__NEXT_DATA__", true);
			const props = getValue(json, "props.pageProps", true);
			this.id = getValue(props, "__DATA_LAYER__.workId", true);
			apollo = getValue(props, "__APOLLO_STATE__", true);
			work = getValue(apollo, `Work:${this.id}`, true);

		} catch (e) {
			utils.debug(e);
			this.id = "";
			this.url = "";
			this.local = false;
			this.html = "";
			throw e;
		}

		// now the json seems to be valid. from here missing fields are
		// ignored and left empty.
		this.title = work.title;
		this.baseColor = work.baseColor;
		this.catchphrase = work.catchphrase;
		this.introduction = work.introduction;
		this.genre = work.genre;
		this.serialStatus = work.serialStatus;
		this.isCruel = work.isCruel;
		this.isViolent = work.isViolent;
		this.isSexual = work.isSexual;
		this.publicEpisodeCount = work.publicEpisodeCount;
		this.totalCharacterCount = work.totalCharacterCount;
		this.publishedAt = work.publishedAt;
		this.editedAt = work.editedAt;
		this.coverUrl = work.adminCoverImageUrl;

		// get the author information.
		const author = getValue(apollo, getValue(work, "author.__ref"));
		if (author) {
			this.author = author.activityName;
			if (!this.author) {
				this.author = author.name;
			}
		}

		// construct lists of chapters and episodes.
		const tocRefs: jsonRef[] = getValue(work, "tableOfContentsV2") ?? [];
		const chapDig = tocRefs.length.toString().length;
		const epiDig = this.publicEpisodeCount.toString().length;

		let order = 0;	// order of chapters and episodes
		let count = 0;	// number of total episodes

		for (let i = 0; i < tocRefs.length; i++) {
			const chapter: Chapter = {
				id: "",
				level: 0,
				title: "",
				titleFormatted: "",
				order: 0,
				serialName: "",
				episodes: [],
			};

			// referenced toc entry defines a chapter.
			const toc: jsonToc = getValue(apollo, tocRefs[i]?.__ref ?? "");
			if (toc && toc.chapter) {
				const chap: jsonChapter =
						getValue(apollo, toc.chapter.__ref) ?? {};
				chapter.id = chap.id;
				chapter.level = chap.level;
				chapter.title = chap.title;
				chapter.titleFormatted = markupText(chap.title) ?? chap.title;
				chapter.order = ++order;
				chapter.serialName = "c"
						+ (i + 1).toString().padStart(chapDig, "0");
			} else {
				// no chapter, episodes only.
				assert(tocRefs.length === 1);
				assert(i === 0);
			}

			// chapter contains episodes.
			const epiRefs: jsonRef[] = toc.episodeUnions ?? [];
			for (let j = 0; j < epiRefs.length; j++) {
				const epi: jsonEpisode =
						getValue(apollo, epiRefs[j]?.__ref ?? "") ?? {};
				const episode: Episode = {
					id: epi.id,
					title: epi.title,
					titleFormatted: markupText(epi.title) ?? epi.title,
					publishedAt: epi.publishedAt,
					order: ++order,
					serialName: chapter.serialName + "e"
							+ (++count).toString().padStart(epiDig, "0"),
				};
				if (j === 0 && chapter.id !== "") {
					// first episode in the chapter.
					episode.newChapter = {
						id: chapter.id,
						title: chapter.title,
						titleFormatted: chapter.titleFormatted,
					};
				}
				chapter.episodes.push(episode);
			}
			this.chapters.push(chapter);
		}

		utils.debug(`Work loaded with ${err} error(s).`);
		return (err === 0);
	}

	/**
	 * Returns the Work metadata.
	 * @throws {KkymError} if the work is not loaded.
	 **/
	public getMetadata(): Metadata {
		if (!this.id) {
			throw new KkymError("Work is not loaded.");
		}
		const meta: Metadata = {
			id: this.id,
			title: this.title,
			author: this.author,
			baseColor: this.baseColor,
			genre: this.genre,
			catchphrase: this.catchphrase,
			introduction: this.introduction,
			isCruel: this.isCruel,
			isViolent: this.isViolent,
			isSexual: this.isSexual,
			serialStatus: this.serialStatus,
			publicEpisodeCount: this.publicEpisodeCount,
			totalCharacterCount: this.totalCharacterCount,
			publishedAt: this.publishedAt,
			editedAt: this.editedAt,
			coverUrl: this.coverUrl,
			titleStripped: stripPromo(this.title),
			localeStrings: {
				genre: "",
				serialStatus: "",
				publicEpisodeCount: "",
				totalCharacterCount: "",
				publishedAt: { "date": "", "time": "" },
				editedAt: { "date": "", "time": "" },
			},
		};
		for (const k in meta.localeStrings) {
			const key = k as MetaLocaleStringKey;
			const map = localeStringsMap[key];
			if (map !== undefined) {
				meta.localeStrings[key] = (typeof map === "function") ?
						map(meta[key]) : map[meta[key]] ?? meta[key];
			}
		}
		return meta;
	}

	/**
	 * Returns an object containing the work information, which can then be
	 * passed to `Mustache.render` as `view` parameter.
	 * The `localeStrings` fields in `Work`, `Chapter`, `Episode` objects
	 * are populated.
	 **/
	public makeWorkView(): Work
	{
		let view: Work = {
			...this.getMetadata(),
			//chapters: structuredClone(this.chapters),
		};
		if (view.introduction) {
			view.introduction = "<p>"
					+ view.introduction.replace(/\n/g, "</p>\n<p>")
					+ "</p>";
		}
		const setEpisodeExtra = (episodes: Episode[]) => {
			for (const episode of episodes) {
				episode.localeStrings = {
					publishedAt: localeDateTime(episode.publishedAt),
				};
			}
		};
		if (this.chapters[0]?.id !== "") {
			// has chapters.
			view.chapters = structuredClone(this.chapters);
			for (const chapter of view.chapters) {
				setEpisodeExtra(chapter.episodes);
			}
		} else {
			// no chapter, episodes only.
			assert(this.chapters.length === 1);
			assert(this.chapters[0].episodes.length);
			view.episodes = structuredClone(this.chapters[0]?.episodes ?? []);
			setEpisodeExtra(view.episodes);
		}
		return view;
	}

	/**
	 * Renders the work information.
	 * @param file - Output filename. Can be a Mustache template string
	 * to use `Metadata` values.
	 * @param overwrite - If defined, specifies whether to overwrite the
	 * the existing file. If undefined, prompts user for confirmation.
	 * @param template - Mustache template filename to convert the HTML
	 * content. If not specifieed, the raw HTML is emitted.
	 * @returns true on success, or false if the file exists and skipped.
	 * @throws {KkymError} if the object is not loaded with a valid work,
	 * or any error from Node.js.
	 **/
	public async renderWork(file?: string, overwrite?: boolean,
			template?: string): Promise<boolean>
	{
		assert(this.id && this.url && this.html);
		const view = template ? this.makeWorkView() : this.getMetadata();
		let content: string;

		if (template) {
			// render with a mustache template.
			utils.debug("Using template:", template);
			const tpl = await fs.promises.readFile(template, "utf-8");
			content = Mustache.render(tpl, view);
		} else {
			content = this.html;
		}

		if (file && file.includes("{{")) {
			if (view.chapters) {
				// clear chapters array just in case.
				view.chapters.length = 0;
			}
			file = Mustache.render(file, view);
		}
		return await utils.writeFile(content, file, overwrite);
	}

	/**
	 * Renders chapter title pages. Not tested at all.
	 **/
	//public async renderChapters(template: string,
	//		dir: string, pattern?: string, overwrite?: boolean,
	//		logFn?: (...args: any) => void): Promise<number[]>
	//{
	//	assert(this.id && this.url);
	//	if (!this.chapter.length) {
	//		throw new KkymError("Work has no chapter/episodes.");
	//	}
	//	if (this.chapter.length === 1 && this.chapter[0].id === "") {
	//		utils.debug("Work has no chapter.");
	//		return [ 0, 0, 0 ];
	//	}

	//	// prepare template string if necessary.
	//	let tpl: string;
	//	try {
	//		tpl = await fs.promises.readFile(template, "utf-8");
	//	} catch (e) {
	//		utils.debug("Failed to read template:", template);
	//		throw e;
	//	}

	//	// iterate through chapters.
	//	let saved = 0, skipped = 0, failed = 0;
	//	if (!pattern) pattern = "{{id}}.html";
	//	if (logFn === undefined) logFn = () => {};

	//	for (const chapter of this.chapters) {
	//		const file = NodePath.join(dir,
	//				Mustache.render(pattern, chapter));
	//		// check the output file existence.
	//		if (!await utils.checkOverwrite(file, overwrite)) {
	//			logFn("Skipped:", file);
	//			skipped++;
	//			continue;
	//		}
	//		// render chapter.
	//		const content = Mustache.render(tpl, chapter);
	//		try {
	//			// overwrite if file exists, as already confirmed.
	//			if (await utils.writeFile(content, file, true)) {
	//				logFn("Saved:", file);
	//				saved++;
	//			}
	//		} catch (e) {
	//			utils.warn(e);
	//			failed++;
	//		}
	//	}

	//	logFn(`Chapters saved ${saved}, skipped ${skipped}, failed ${failed}.`);
	//	return [ saved, skipped, failed ];
	//}

	/**
	 * Renders all episodes in the current work and save each into the
	 * specified directory The caller must ensure that `dir` exists.
	 * @returns An array of numbers of episodes [ saved, skipped, failed ].
	 * @throws Any error from Node.js if the template (if any) cannot be
	 * read. Per-episode errors will be ignored but counted as failed in
	 * the returned array.
	 **/
	public async renderEpisodes(template: string | null,
			dir: string, pattern?: string, overwrite?: boolean,
			logFn?: (...args: any) => void): Promise<number[]>
	{
		assert(this.id && this.url);
		if (!pattern) pattern = "{{id}}.html";

		// prepare template string if necessary.
		let tpl: string | undefined;
		if (template) {
			utils.debug("Rendering episodes with template:", template);
			try {
				tpl = await fs.promises.readFile(template, "utf-8");
			} catch (e) {
				utils.debug("Unable to read template.");
				throw e;
			}
		}

		// iterate through episodes.
		let saved = 0, skipped = 0, failed = 0;
		if (logFn === undefined) logFn = () => {};

		for (const chapter of this.chapters) {
			// process episodes only.
			for (const episode of chapter.episodes) {
				const file = NodePath.join(dir,
						Mustache.render(pattern, episode));
				// check the output file before accessing the source data.
				if (!await utils.checkOverwrite(file, overwrite)) {
					logFn("Skipped:", file);
					skipped++;
					continue;
				}
				// read and write episode content.
				try {
					const content = await this.episodeContent(episode, tpl);
					if (await utils.writeFile(content, file, true)) {
						logFn("Saved:", file);
						saved++;
					}
				} catch (e) {
					utils.warn(e);
					failed++;
				}
			}
		}

		logFn(`Episodes saved ${saved}, skipped ${skipped}, failed ${failed}.`);
		return [ saved, skipped, failed ];
	}

	/**
	 * Renders a single episode in the current work.
	 * Provided for testing purposes, not for practical use.
	 * @param id - Episode ID string, 1-based index number, or
	 * Episode object.
	 * @param file - Output filename. If undefined, stdout will be used.
	 **/
	public async renderEpisode(template: string | null,
			id: string | number | Episode,
			file?: string, overwrite?: boolean): Promise<boolean>
	{
		assert(this.id && this.url);

		// get Episode object.
		let episode: Episode | undefined = undefined;
		if (typeof id === "number") {
			if (0 < id) {
				let i = id - 1;
				for (const chapter of this.chapters) {
					if (i < chapter.episodes.length) {
						episode = chapter.episodes.at(i);
						break;
					}
					i -= chapter.episodes.length;
					if (i < 0) break;	// not found
				}
			}
		} else if (typeof id === "string") {
			for (const chapter of this.chapters) {
				episode = chapter.episodes.find((value) => {
					return (id === value.id);
				});
				if (episode !== undefined) break;
			}
		} else {
			// assume Episode object.
			episode = id;
		}
		if (episode === undefined) {
			throw new KkymError(`Invalid episode ID or index: ${id}`);
		}

		// determine the output filename.
		if (file !== undefined) {
			if (file.includes("{{")) {
				file = Mustache.render(file, episode);
			}
			// check the output file before accessing the source data.
			if (!await utils.checkOverwrite(file, overwrite)) {
				return false;
			}
		}

		// read and write the episode content.
		let tpl: string | undefined;
		if (template) {
			utils.debug("Using template:", template);
			try {
				tpl = await fs.promises.readFile(template, "utf-8");
			} catch (e) {
				utils.debug("Failed to read template file.", e);
				throw e;
			}
		}
		const content = await this.episodeContent(episode, tpl);
		return await utils.writeFile(content, file, true);
	}

	/**
	 * Returns the episode content, either in the raw HTML format or
	 * as rendered using `template`.
	 * By default, the episode content is read from the same location as
	 * the work page, either from a local file <ID>.html or from the
	 * Kakuyomu website. Or if `KkymWork.fetchEpisodes` is set to true,
	 * the content is always taken from the website regardless of the work
	 * location.
	 * @param episode - Episode object.
	 * @param template - Mustache template string to apply.
	 * @returns Episode content string.
	 * @throws Any error from Node.js/fs/JSDOM.
	 **/
	protected async episodeContent(episode: Episode,
			template?: string): Promise<string>
	{
		let html;
		try {
			if (!this.local || this.fetchEpisodes) {
				// read from the website.
				const url = `${this.url}/episodes/${episode.id}`;
				utils.debug("Fetching episode:", url);
				const response = await fetch(url);
				html = await response.text();
			} else {
				// read from a local file.
				const dir = NodePath.dirname(this.url);
				let file = NodePath.join(dir, `${episode.id}.html`);
				if (!fs.existsSync(file)) {
					// try .htm extension.
					file = file.slice(0, file.length - 1);
				}
				utils.debug("Reading episode:", file);
				html = await fs.promises.readFile(file, "utf-8");
			}
		} catch (e) {
			utils.debug("Failed to read episode.", e);
			throw e;
		}

		// if template is not used, simply return the raw html.
		if (!template) {
			return html;
		}

		// extract the body part.
		const dom = new JSDOM(html);
		let content;
		try {
			const key = "js-episode-body";
			const elems = dom.window.document.getElementsByClassName(key);
			if (!elems || !elems.length) {
				throw new KkymError(`Episode ${episode.id}: `
						+ `Element with class="${key}" was not found.`);
			}
			content = Array.from(elems).map((elem) => {
				markupChild(elem);
				return elem.innerHTML.trim();
			}).join("\n");
		} finally {
			dom.window.close();
		}

		if (!content) {
			utils.debug("Episode is empty.");
			return content;
		}

		// XMLSerializer is not available in Node.js, so manually
		// correct possible stand-alone tags. If other complex tags are
		// found, consider using xmldom or something else.
		content = content.replace(/<(br(?:\s[^<>]*[^<>/])?)>/ig, "<$1/>");
		content = content.replace(/<(br)>/ig, "<$1/>");

		// apply mustache template.
		let view = {
			...episode,
			localeStrings: {
				publishedAt: localeDateTime(episode.publishedAt),
			},
			content: content,
		};
		return Mustache.render(template, view);
	}

	/**
	 * Renders an HTML file as a KkymEpisode episode without work
	 * information. Experimental for testing purposes.
	 **/
	//public static async renderAsEpisode(url: string,
	//		file?: string | undefined, overwrite?: boolean,
	//		template?: string): Promise<boolean>
	//{
	//	let content: string;
	//	try {
	//		let html;
	//		if (url.match(/^https?:/)) {
	//			const response = await fetch(url);
	//			html = await response.text();
	//		} else {
	//			// assume a local file.
	//			if (url.match(/^file:/)) {
	//				url = fileURLToPath(url);
	//			}
	//			html = await fs.promises.readFile(url, "utf-8");
	//		}
	//		const elem = getHtmlElement(html, "contentMain-inner");
	//		content = elem.innerHTML as string;
	//	} catch (e) {
	//		utils.debug(`Failed to read file as episode: ${url}`, e);
	//		throw e;
	//	}
	//	if (template) {
	//		// render with a mustache template.
	//		try {
	//			const tpl = await fs.promises.readFile(template, "utf-8");
	//			content = Mustache.render(tpl, { content: content });
	//		} catch (e) {
	//			utils.debug("Failed to apply template:", template, e);
	//			throw e;
	//		}
	//	}
	//	return await utils.writeFile(content, file, overwrite);
	//}

	/**
	 * Saves the cover image (if any) with the specified filename.
	 * If the work was loaded locally, the image is supposed to exist
	 * in the same directory as the work file unless
	 * `KkymWork.fetchCover` is set to `true`.
	 * @returns An object containing the image size and format as
	 * `{ width: number, height: number, format: string }`.
	 * If the work doesn't have a cover image, or `file` already exists
	 * and not to be overwritten, `null` is returned.
	 * @throws Any error from Node.js or dependent module.
	 **/
	public async saveCover(file: string, format?: string,
			overwrite?: boolean): Promise<Record<string, any> | null>
	{
		// check the output file existence before accessing the source data.
		if (file !== undefined) {
			if (!await utils.checkOverwrite(file, overwrite)) {
				return null;
			}
		}

		let buffer: Buffer<ArrayBuffer>;

		if (!this.local || this.fetchCover) {
			// download from the original url.
			utils.debug("Fetching cover image:", this.coverUrl);
			const response = await fetch(this.coverUrl);
			const data = await response.bytes();
			buffer = Buffer.from(data);
		} else {
			// use local file.
			const src = NodePath.join(NodePath.dirname(this.url),
					NodePath.basename(this.coverUrl));
			utils.debug("Using local image:", src);
			const data = await fs.promises.readFile(src);
			buffer = Buffer.from(data);
		}

		let dim = imageSize(buffer);
		if (dim.type === "jpg") dim.type = "jpeg";	// fix format specifier

		// convert the format if necessary.
		if (format !== undefined && format !== dim.type) {
			utils.debug("Converting image:", dim.type, "to", format);
			buffer = await convertImageFormat(buffer, format);
			dim = imageSize(buffer);
			if (dim.type == null) dim.type = format;
			else if (dim.type === "jpg") dim.type = "jpeg";
		}

		await utils.writeFile(buffer, file, true);
		utils.debug("Saved:", file, dim);
		return {
			width: dim.width,
			height: dim.height,
			type: dim.type,
		};
	}
}
