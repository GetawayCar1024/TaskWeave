import hljs from 'highlight.js/lib/core';
import cpp from 'highlight.js/lib/languages/cpp';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
export function codeHtml(text: string, language = '') {
  if (text.length > 100_000) return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (hljs.getLanguage(language)) return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  return hljs.highlightAuto(text, ['cpp', 'python', 'java', 'javascript', 'json']).value;
}
