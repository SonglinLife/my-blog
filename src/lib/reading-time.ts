/** Estimate reading time in minutes from raw markdown text */
export function getReadingTime(text: string): number {
	const words = text.trim().split(/\s+/).length;
	// ~200 words/min for Chinese-mixed content
	const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
	const minutes = (words - cjkChars) / 250 + cjkChars / 400;
	return Math.max(1, Math.ceil(minutes));
}
