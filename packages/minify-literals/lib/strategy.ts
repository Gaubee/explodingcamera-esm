import CleanCSS from "clean-css";
import { type Options as HTMLOptions, minify } from "html-minifier-terser";
import type { TemplatePart } from "parse-literals";

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
	getPlaceholder(parts: TemplatePart[]): string;
	/**
	 * Combines the parts' HTML text strings together into a single string using
	 * the provided placeholder. The placeholder indicates where a template
	 * expression occurs.
	 *
	 * @param parts the parts to combine
	 * @param placeholder the placeholder to use between parts
	 * @returns the combined parts' text strings
	 */
	combineHTMLStrings(parts: TemplatePart[], placeholder: string): string;
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
	splitHTMLByPlaceholder(html: string, placeholder: string): string[];
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
	getPlaceholder(parts) {
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
		return parts.map((part) => part.text).join(placeholder);
	},

	async minifyHTML(html, options = {}) {
		let minifyCSSOptions: HTMLOptions["minifyCSS"];

		if (html.match(/<!--(.*?)@TEMPLATE_EXPRESSION\(\);(.*?)-->/g)) {
			console.warn(
				"minify-html-literals: HTML minification is not supported for template expressions inside comments. Minification for this file will be skipped.",
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
				"minify-html-literals: warnings during CSS minification, file was skipped. See above for details.",
			);
			return css.replace(/(\n)|(\r)/g, "");
		}

		output.styles = output.styles.replaceAll("--TEMPLATE-EXPRESSION:", "@TEMPLATE_EXPRESSION();:");
		output.styles = fixCleanCssTidySelectors(css, output.styles);
		return output.styles;
	},
	splitHTMLByPlaceholder(html, placeholder) {
		const parts = html.split(placeholder);
		// Make the last character (a semicolon) optional. See above.
		if (placeholder.endsWith(";")) {
			const withoutSemicolon = placeholder.substring(0, placeholder.length - 1);
			for (let i = parts.length - 1; i >= 0; i--) {
				parts.splice(i, 1, ...(parts[i]?.split(withoutSemicolon) ?? []));
			}
		}

		return parts;
	},
};

export function adjustMinifyCSSOptions(options: CleanCSS.Options = {}) {
	const level = options.level;

	const plugin = {
		level1: {
			value: function (_name: any, value: string) {
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
