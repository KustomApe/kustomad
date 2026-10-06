/**
 * Splits a shell command line into simple commands (lists of words), the way a reader
 * would: separators `;`, `&&`, `||`, `|`, `&`, newlines and parentheses end a command,
 * quotes group words, redirections are dropped, and `$(…)` / backticks are commands of
 * their own (listed after the ones around them). Good enough to see what a command runs;
 * not a shell.
 */
export function simpleCommands(line: string): string[][] {
	const commands: string[][] = [];
	const nested: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let index = 0;

	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length) commands.push(words);
		words = [];
	};
	// Reads a balanced `$( … )` body starting after the opening parenthesis.
	const readSubstitution = (): string => {
		let depth = 1;
		let body = "";
		let quote: string | undefined;
		while (index < line.length) {
			const char = line[index]!;
			index++;
			if (quote) {
				if (char === quote) quote = undefined;
				else if (char === "\\" && quote === '"' && index < line.length) {
					body += char + line[index]!;
					index++;
					continue;
				}
			} else if (char === "'" || char === '"') quote = char;
			else if (char === "(") depth++;
			else if (char === ")") {
				depth--;
				if (!depth) return body;
			}
			body += char;
		}
		return body;
	};
	const readBacktick = (): string => {
		let body = "";
		while (index < line.length && line[index] !== "`") {
			if (line[index] === "\\" && index + 1 < line.length) {
				body += line[index + 1]!;
				index += 2;
				continue;
			}
			body += line[index]!;
			index++;
		}
		index++;
		return body;
	};
	// Skips one word (a redirection's target), quotes included.
	const skipWord = () => {
		while (index < line.length && (line[index] === " " || line[index] === "\t")) index++;
		let quote: string | undefined;
		while (index < line.length) {
			const char = line[index]!;
			if (quote) {
				if (char === quote) quote = undefined;
			} else if (char === "'" || char === '"') quote = char;
			else if (/[\s;&|()<>]/.test(char)) break;
			index++;
		}
	};

	while (index < line.length) {
		const char = line[index]!;
		if (char === "\\") {
			if (line[index + 1] === "\n") {
				index += 2;
				continue;
			}
			word += line[index + 1] ?? "";
			inWord = true;
			index += 2;
			continue;
		}
		if (char === "'") {
			const end = line.indexOf("'", index + 1);
			word += line.slice(index + 1, end < 0 ? undefined : end);
			inWord = true;
			index = end < 0 ? line.length : end + 1;
			continue;
		}
		if (char === '"') {
			index++;
			inWord = true;
			while (index < line.length && line[index] !== '"') {
				if (line[index] === "\\" && index + 1 < line.length && /["\\$`]/.test(line[index + 1]!)) {
					word += line[index + 1]!;
					index += 2;
				} else if (line[index] === "$" && line[index + 1] === "(") {
					index += 2;
					nested.push(...simpleCommands(readSubstitution()));
				} else if (line[index] === "`") {
					index++;
					nested.push(...simpleCommands(readBacktick()));
				} else {
					word += line[index]!;
					index++;
				}
			}
			index++;
			continue;
		}
		if (char === "$" && line[index + 1] === "(") {
			index += 2;
			nested.push(...simpleCommands(readSubstitution()));
			continue;
		}
		if (char === "`") {
			index++;
			nested.push(...simpleCommands(readBacktick()));
			continue;
		}
		if (char === "#" && !inWord) {
			while (index < line.length && line[index] !== "\n") index++;
			continue;
		}
		if (char === "<" || char === ">" || (char === "&" && line[index + 1] === ">")) {
			// A file-descriptor number right before the operator belongs to it.
			if (inWord && /^\d+$/.test(word)) {
				word = "";
				inWord = false;
			}
			endWord();
			let operator = "";
			while (index < line.length && /[<>&|]/.test(line[index]!) && operator.length < 3) {
				if (line[index] === "&" && operator && line[index + 1] !== undefined && /[\d-]/.test(line[index + 1]!)) {
					operator += "&";
					index++;
					break;
				}
				if (line[index] === "&" && operator && !/[>]$/.test(operator)) break;
				if (line[index] === "|" && operator !== ">") break;
				operator += line[index]!;
				index++;
			}
			if (operator.endsWith("&") && operator !== "&>") {
				while (index < line.length && /[\d-]/.test(line[index]!)) index++;
			} else if (operator === "<<" || operator === "<<-") {
				skipWord();
			} else {
				skipWord();
			}
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "\n" || char === "(" || char === ")") {
			endCommand();
			index++;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			endWord();
			index++;
			continue;
		}
		word += char;
		inWord = true;
		index++;
	}
	endCommand();
	return [...commands, ...nested];
}

/** Quotes a word for a POSIX shell, only when it needs it. */
export function shellQuote(word: string): string {
	if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(word)) return word;
	return `'${word.replace(/'/g, `'\\''`)}'`;
}
