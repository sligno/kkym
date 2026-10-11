import * as fs from "node:fs";

/// Error and Debug Messages

/**
 * A typeguarded version of `instanceof Error` for NodeJS.
 * @author Joseph JDBar Barron
 * @link https://dev.to/jdbar
 *
 * For details, see:
 * https://dev.to/jdbar/the-problem-with-handling-node-js-errors-in-typescript-and-the-workaround-m64
 */
function instanceOfNodeError<T extends new (...args: any) => Error>(
    value: Error,
    errorType: T
): value is InstanceType<T> & NodeJS.ErrnoException {
    return value instanceof errorType;
}

export function error(err: any, ...args: any): void
{
	let message;
	if (err instanceof ReferenceError) {
		// likely an coding error, include stack trace.
		message = err.toString();
	} else if (instanceOfNodeError(err, Error)) {
		if (err.syscall !== undefined) {
			message = "Syscall error";
			if (err.errno !== undefined) {
				message += ` (${err.errno})`;
			}
			message += ": " + fixSentence(err.message);
		} else {
			message = fixSentence(err.toString());
		}
	} else {
		message = `Error: ${err}`;
	}
	console.error(message, ...args);
}

export function warn(...args: any): void
{
	console.warn("Warning:", ...args);
}

export function debug(...args: any): void
{
	let prefix = "\x1b[1m\x1b[33m[DEBUG]\x1b[0m";
	if (process.env.VERBOSE) {
		const err = new Error();
		const lines = err.stack?.split("\n") || [];
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i]?.includes("at Module.debug")) {
				continue;
			}
			if (++i < lines.length) {
				const pos = lines[i]?.indexOf(" (") ?? -1;
				const caller = (0 < pos) ?
						lines[i]?.slice(0, pos).trim().replace(/^at +/i, "")
						: "";
				if (caller !== undefined && caller !== "") {
					prefix += ` \x1b[1m\x1b[30m(${caller})\x1b[0m`;
				}
			}
			break;
		}
		console.debug(prefix, ...args);
	}
}

export function fixSentence(str: string): string
{
	let sentence = "";
	let prefix = str.match(/^[a-z][^:]+: +/i);
	if (prefix) {
		sentence = prefix[0].charAt(0).toUpperCase() + prefix[0].slice(1);
		str = str.slice(prefix[0].length);
	}
	if (!prefix || prefix[0] !== "TypeError: ") {
		sentence += str.charAt(0).toUpperCase();
		str = str.slice(1);
	}
	if (!str.includes(':')) {
		str = str.replace(/([^.!?;])([\r\n]*)$/, "$1.$2");
	}
	sentence += str;
	return sentence;
}

/// User Interaction

/**
 * Prompts user for one of predefined characters. Case is ignored.
 * @param message - Message text.
 * @param chars - Characters to be accepted.
 * @returns Returns the character user typed, in lower-case.
 * @throws {Error} when CTRL+C is pressed.
 **/
export async function readChar(message: string, chars?: string): Promise<string>
{
	let raw = false;
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		raw = true;
	}
	process.stdin.setEncoding("utf-8");

	const readInput: (prompt?: string) => Promise<string> = (prompt) =>
		new Promise((resolve, reject) => {
			const listener = (ch: string) => {
				process.stdin.off("data", listener);
				process.stdin.pause();
				if (ch === "\x03") {
					process.stdout.write("^C");
					reject(new Error("^C"));
				}
				resolve(ch);
			};
			if (prompt) process.stdout.write(prompt);
			process.stdin.resume();
			process.stdin.on("data", listener);
		});

	try {
		let char = await readInput(message);
		if (chars) {
			chars = chars.toLowerCase();
			while (!chars.includes(char.toLowerCase())) {
				process.stdout.write("\x07");	// beep
				char = await readInput();
			}
		}
		process.stdout.write(char);
		return char.toLowerCase();

	} catch (e) {
		if (e instanceof Error && e.message === "^C") {
			// exit after finally.
		} else {
			throw e;
		}

	} finally {
		if (raw) process.stdin.setRawMode(false);
		process.stdout.write("\n");
	}

	process.exit(1);
}

/// Directory/Path Operations

export function isDir(dir: string): boolean | undefined
{
	try {
		const stat = fs.statSync(dir);
		return stat.isDirectory();
	} catch (e: any) {
		if (e.code !== "ENOENT") {
			debug(e);
			throw e;
		}
	}
	return undefined;	// dir does not exist
}

/**
 * Ensures that the directory exists. If not, create it.
 * @param dir - Diretcory path to check or create.
 * @param mkdir Specifies whether to create the directory if not exist.
 * When set to true, directory creation is done without prompt.
 * When set to false, an error is thrown if the directory does not exist.
 * When undefined, prompt use for creating a directory.
 * @returns Returns a positive value on success (1 = alerady exists,
 * 2 = newely created), or 0 if the directory creation is rejected by
 * user.
 * @throws Any error from Node.js.
 **/
export async function ensureDir(dir: string,
		mkdir: boolean | undefined = undefined): Promise<number>
{
	const stat = isDir(dir);
	if (stat !== undefined) {
		if (stat) return 1;		// already exists
		throw new Error(`Path is not a directoey: ${dir}`);
	}
	if (mkdir === false) {
		throw new Error(`Directory does not exst: ${dir}`);
	}
	if (mkdir === undefined) {
		const ans = await readChar(
				`Directory does not exist: ${dir}\nCreate it? (y/n): `,
				"yn");
		if (ans !== "y") return 0;
	}
	debug("Creating directory:", dir);
	await fs.promises.mkdir(dir);
	return 2;
}

/// File Operations

/**
 * Prompts user for confirmation of overwriting existing file.
 **/
export async function checkOverwrite(file: string,
		overwrite: boolean | undefined): Promise<boolean>
{
	if (overwrite === true || !fs.existsSync(file)) return true;
	if (overwrite === false) return false;
	const answer = await readChar(
			`File already exists: ${file}\nOverwrite? (y/n): `, "yn");
	return (answer === "y");
}

/**
 * Writes data to the specified file or stdout.
 * @param content - String or binary data to be written.
 * @param file - Output filename. If undefined, stdout will be used.
 * @param overwrite - Whether to overwrite if the output file exists.
 * If undefined, a prmopt will be shown using `checkOverwrite`.
 * @throws Any error from Node.js.
 **/
export async function writeFile(content: string | NodeJS.ArrayBufferView,
		file?: string, overwrite?: boolean): Promise<boolean>
{
	if (file === undefined) {
		// write to stdout.
		if (typeof content === "string") {
			process.stdout.write(content);
		} else {
			fs.writeFileSync(1, content);
		}
	} else {
		// write to file.
		if (overwrite !== true) {
			if (!await checkOverwrite(file, overwrite)) {
				return false;
			}
		}
		debug("Saving:", file);
		await fs.promises.writeFile(file, content);
	}
	return true;
}
