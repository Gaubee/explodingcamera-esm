import CleanCSS from "clean-css";
import { type Options as HTMLOptions, minify } from "html-minifier-terser";
import type { TemplatePart } from "parse-literals";
import { randomBytes, randomInt } from "node:crypto";

/**
 * A strategy on how to minify HTML and optionally CSS.
 *
 * @template O minify HTML options
 * @template C minify CSS options
 */
export interface Strategy<O = any, C = any> {
	/**
	 * Retrieve a placeholder for the given array of template parts. The
	 * placeholder returned should be the same if the function is invoked with the
	 * same array of parts.
	 *
	 * The placeholder should be an HTML-compliant string that is not present in
	 * any of the parts' text.
	 *
	 * @param parts the parts to get a placeholder for
	 * @returns the placeholder
	 */
	getPlaceholder(parts: TemplatePart[], tag?: string): string | string[];
	/**
	 * Combines the parts' HTML text strings together into a single string using
	 * the provided placeholder. The placeholder indicates where a template
	 * expression occurs.
	 *
	 * @param parts the parts to combine
	 * @param placeholder the placeholder to use between parts
	 * @returns the combined parts' text strings
	 */
	combineHTMLStrings(parts: TemplatePart[], placeholder: string | string[]): string;
	/**
	 * Minfies the provided HTML string.
	 *
	 * @param html the html to minify
	 * @param options html minify options
	 * @returns minified HTML string
	 */
	minifyHTML(html: string, options?: O): Promise<string>;
	/**
	 * Minifies the provided CSS string.
	 *
	 * @param css the css to minfiy
	 * @param options css minify options
	 * @returns minified CSS string
	 */
	minifyCSS?(css: string, options?: C): Promise<string>;
	/**
	 * Splits a minfied HTML string back into an array of strings from the
	 * provided placeholder. The returned array of strings should be the same
	 * length as the template parts that were combined to make the HTML string.
	 *
	 * @param html the html string to split
	 * @param placeholder the placeholder to split by
	 * @returns an array of html strings
	 */
	splitHTMLByPlaceholder(html: string, placeholder: string | string[]): string[];
}

/**
 * The default <code>clean-css</code> options, optimized for production
 * minification.
 */
export const defaultMinifyCSSOptions: CleanCSS.Options = {};

/**
 * The default <code>html-minifier</code> options, optimized for production
 * minification.
 */
export const defaultMinifyOptions: HTMLOptions = {
	caseSensitive: true,
	collapseWhitespace: true,
	decodeEntities: true,
	minifyCSS: defaultMinifyCSSOptions,
	minifyJS: true,
	processConditionalComments: true,
	removeAttributeQuotes: false,
	removeComments: true,
	removeEmptyAttributes: true,
	removeScriptTypeAttributes: true,
	removeStyleLinkTypeAttributes: true,
	useShortDoctype: true,
};

/**
 * The default strategy. This uses <code>html-minifier</code> to minify HTML and
 * <code>clean-css</code> to minify CSS.
 */
export const defaultStrategy: Strategy<HTMLOptions, CleanCSS.Options> = {
	getPlaceholder(parts, tag) {
		const isCss = tag?.toLowerCase().includes("css");
		if (isCss) {
			// use strict mode to avoid issues with CSS minification
			const random = `tmp_${randomBytes(6).toString("hex")}`;
			const placeholder: string[] = [];
			const comment = /\/\*[\s\S]*?\*\//g;
			for (let i = 1; i < parts.length; i++) {
				const beforeFull = parts[i - 1]!.text;
				const beforeCss = beforeFull.replace(comment, "");
				const afterFull = parts[i]!.text;
				const afterCss = afterFull.replace(comment, "");
				/**
				 * 1. selector
				 * ${selector} {
				 * }
				 *
				 * 2. key
				 * selector {
				 * 	 ${key}: value;
				 * }
				 *
				 * 3. rule
				 * [selector {}]
				 * ${rule}
				 * [selector {}]
				 *
				 * 4. number-literal
				 * selector{
				 *   key: ${param}px;
				 * }
				 *
				 * 5. value
				 * selector {
				 * 	 key: ${value};
				 * 	 key: ${value}
				 * }
				 *
				 * 6. param
				 * selector{
				 *   key: fun(${param}[, ${param}]);
				 * }
				 */

				const isSelector = /^\s*\{/.test(afterCss);
				if (isSelector) {
					placeholder.push(`#${random}`);
					continue;
				}
				const isKey = /^\s*:/.test(afterCss);
				if (isKey) {
					placeholder.push(`--${random}`);
					continue;
				}
				const isRule = /\}\s*$/.test(beforeCss) || beforeCss.trim().length === 0;
				if (isRule) {
					return `@${random}();`;
				}
				const isUnit = /^\w+/.test(afterCss);
				if (isUnit) {
					let num: string;
					while (true) {
						num = `${randomInt(281474976710655)}`;
						if (!beforeFull.includes(num)) {
							break;
						}
					}
					placeholder.push(num);
					continue;
				}
				const isValue = /:\s*$/.test(beforeCss);
				if (isValue) {
					placeholder.push(`var(--${random})`);
					continue;
				}

				// isParams
				placeholder.push(`var(--${random})`);
			}
			return placeholder;
		}
		// Using @ and (); will cause the expression not to be removed in CSS.
		// However, sometimes the semicolon can be removed (ex: inline styles).
		// In those cases, we want to make sure that the HTML splitting also
		// accounts for the missing semicolon.
		const suffix = "();";
		let placeholder = "@TEMPLATE_EXPRESSION";
		while (parts.some((part) => part.text.includes(placeholder + suffix))) {
			placeholder += "_";
		}

		return placeholder + suffix;
	},

	combineHTMLStrings(parts, placeholder) {
		if (typeof placeholder === "string") {
			return parts.map((part) => part.text).join(placeholder);
		}
		return parts.map((part, i) => part.text + (placeholder[i] ?? "")).join("");
	},

	async minifyHTML(html, options = {}) {
		let minifyCSSOptions: HTMLOptions["minifyCSS"];

		if (html.match(/<!--(.*?)@TEMPLATE_EXPRESSION\(\);(.*?)-->/g)) {
			console.warn(
				"minify-literals: HTML minification is not supported for template expressions inside comments. Minification for this file will be skipped.",
			);
			return html;
		}

		html = html.replaceAll("<@TEMPLATE_EXPRESSION();", "<TEMPLATE_EXPRESSION___");
		html = html.replaceAll("</@TEMPLATE_EXPRESSION();", "</TEMPLATE_EXPRESSION___");

		if (options.minifyCSS) {
			if (options.minifyCSS !== true && typeof options.minifyCSS !== "function") {
				minifyCSSOptions = { ...options.minifyCSS };
			} else {
				minifyCSSOptions = {};
			}
		} else {
			minifyCSSOptions = false;
		}

		let adjustedMinifyCSSOptions: false | ReturnType<typeof adjustMinifyCSSOptions> = false;
		if (minifyCSSOptions) {
			adjustedMinifyCSSOptions = adjustMinifyCSSOptions(minifyCSSOptions);
		}

		let result = await minify(html, {
			...options,
			minifyCSS: adjustedMinifyCSSOptions,
		});

		result = result.replaceAll("<TEMPLATE_EXPRESSION___", "<@TEMPLATE_EXPRESSION();");
		result = result.replaceAll("</TEMPLATE_EXPRESSION___", "</@TEMPLATE_EXPRESSION();");

		if (options.collapseWhitespace) {
			// html-minifier does not support removing newlines inside <svg>
			// attributes. Support this, but be careful not to remove newlines from
			// supported areas (such as within <pre> and <textarea> tags).
			const matches = Array.from(result.matchAll(/<svg/g)).reverse();
			for (const match of matches) {
				const startTagIndex = match.index ?? 0;
				const closeTagIndex = result.indexOf("</svg", startTagIndex);
				if (closeTagIndex < 0) {
					// Malformed SVG without a closing tag
					continue;
				}

				const start = result.substring(0, startTagIndex);
				let svg = result.substring(startTagIndex, closeTagIndex);
				const end = result.substring(closeTagIndex);
				svg = svg.replace(/\r?\n/g, "");
				result = start + svg + end;
			}
		}
		result = fixCleanCssTidySelectors(html, result);

		return result;
	},
	async minifyCSS(css, options = {}) {
		const adjustedOptions = adjustMinifyCSSOptions(options);

		css = css.replaceAll(/@TEMPLATE_EXPRESSION\(\);:/g, "--TEMPLATE-EXPRESSION:");
		const output = await new CleanCSS({
			...adjustedOptions,
			returnPromise: true,
		}).minify(css);

		if (output.errors?.length) throw new Error(output.errors.join("\n\n"));

		// If there are warnings, return the unminified CSS.
		// CleanCSS can sometimes struggle with our preprocessed CSS due to the replaced template expressions.
		if (output.warnings?.length) console.log(css, output.styles);
		if (output.warnings.length) {
			console.warn(output.warnings.join("\n\n"));
			console.warn(
				"minify-literals: warnings during CSS minification, file was skipped. See above for details.",
			);
			return css.replace(/(\n)|(\r)/g, "");
		}

		output.styles = output.styles.replaceAll("--TEMPLATE-EXPRESSION:", "@TEMPLATE_EXPRESSION();:");
		output.styles = fixCleanCssTidySelectors(css, output.styles);
		return output.styles;
	},
	splitHTMLByPlaceholder(html, placeholder) {
		let parts: string[];
		if (typeof placeholder === "string") {
			parts = html.split(placeholder);
			// Make the last character (a semicolon) optional. See above.
			if (placeholder.endsWith(";")) {
				const withoutSemicolon = placeholder.substring(0, placeholder.length - 1);
				for (let i = parts.length - 1; i >= 0; i--) {
					parts.splice(i, 1, ...(parts[i]?.split(withoutSemicolon) ?? []));
				}
			}
		} else {
			parts = [];
			// strice mode
			let pos = 0;
			let index = -1;
			for (const ph of placeholder) {
				index = html.indexOf(ph, pos);
				if (index === -1) {
					throw new Error(`placeholder ${ph} not found in html ${html}`);
				}
				parts.push(html.slice(pos, index));
				pos = index + ph.length;
			}
			parts.push(html.slice(pos));
		}

		return parts;
	},
};

export function adjustMinifyCSSOptions(options: CleanCSS.Options = {}) {
	const level = options.level;

	const plugin = {
		level1: {
			value: (_name: any, value: string) => {
				if (!value.startsWith("@TEMPLATE_EXPRESSION") || value.endsWith(";")) return value;

				// The CSS minifier has removed the semicolon from the placeholder
				// and we need to add it back.
				return `${value};`;
			},
		},
	};

	return {
		...options,
		level,
		plugins: [plugin],
	};
}

// Should be fixed in clean-css https://github.com/clean-css/clean-css/issues/996, but is still happening
function fixCleanCssTidySelectors(original: string, result: string) {
	const regex = /(::?.+\((.*)\))[\s\r\n]*{/gm;
	let match: RegExpMatchArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: this is fine
	while ((match = regex.exec(original)) != null) {
		const pseudoClass = match[1] ?? "";
		const parameters = match[2];

		if (!parameters?.match(/\s/)) {
			continue;
		}

		const parametersWithoutSpaces = parameters.replace(/\s/g, "");
		const resultPseudoClass = pseudoClass.replace(parameters, parametersWithoutSpaces);
		const resultStartIndex = result.indexOf(resultPseudoClass);
		if (resultStartIndex < 0) {
			continue;
		}

		const resultEndIndex = resultStartIndex + resultPseudoClass.length;
		// Restore the original pseudo class with spaces
		result = result.substring(0, resultStartIndex) + pseudoClass + result.substring(resultEndIndex);
	}

	return result;
}
