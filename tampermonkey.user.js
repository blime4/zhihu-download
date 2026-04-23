// ==UserScript==
// @name         Zhihu2Markdown
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Download Zhihu content (articles, answers, videos, columns) as Markdown
// @author       Glenn
// @match        *://zhuanlan.zhihu.com/p/*
// @match        *://www.zhihu.com/question/*/answer/*
// @match        *://www.zhihu.com/zvideo/*
// @match        *://www.zhihu.com/column/*
// @match        *://blog.csdn.net/*/article/*
// @match        *://blog.csdn.net/*/category_*.html
// @match        *://mp.weixin.qq.com/s*
// @match        *://juejin.cn/post/*
// @match        *://lmsys.org/blog/*
// @match        *://docs.nvda.net.cn/*
// @match        *://docs.pytorch.org/*
// @match        *://docs.huggingface.co/*
// @match        *://tensorflow.org/*/guide/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @require      https://cdn.jsdelivr.net/npm/turndown@7.1.1/dist/turndown.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Add CSS for UI elements
    GM_addStyle(`
        .zhihu-dl-button {
            position: fixed;
            bottom: 30px;
            right: 30px;
            z-index: 10000;
            padding: 12px 16px;
            background: #0084ff;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 15px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .zhihu-dl-button:hover {
            background: #0077e6;
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
        }
        .zhihu-dl-button:before {
            content: "⬇️";
            margin-right: 6px;
            font-size: 16px;
        }
        .zhihu-copy-button {
            position: fixed;
            bottom: 90px;
            right: 30px;
            z-index: 10000;
            padding: 12px 16px;
            background: #0084ff;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 15px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .zhihu-copy-button:hover {
            background: #0077e6;
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
        }
        .zhihu-copy-button:before {
            content: "🔗";
            margin-right: 6px;
            font-size: 16px;
        }
        .zhihu-dl-progress {
            position: fixed;
            bottom: 150px;
            right: 30px;
            z-index: 10000;
            padding: 10px 16px;
            background: white;
            border: 1px solid #eee;
            border-radius: 8px;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            display: none;
        }
    `);

    // Get valid filename (replace invalid characters)
    const getValidFilename = (str) => {
        return str.replace(/[\\/:*?"<>|]/g, '_').trim();
    };

    // Get article date from the page
    const getArticleDate = (selector) => {
        const dateElement = document.querySelector(selector);
        if (!dateElement) return '';

        const dateText = dateElement.textContent.trim();
        const match = dateText.match(/(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : '';
    };

    const normalizeUrl = (url) => {
        if (!url) return '';
        if (url.startsWith('//')) {
            return `https:${url}`;
        }
        return url;
    };

    const extractWechatDate = () => {
        try {
            const scripts = document.querySelectorAll('script[type="text/javascript"]');
            for (const script of scripts) {
                const text = script.textContent || '';
                const timestampMatch = text.match(/var\s+ct\s*=\s*"(\d+)"/) || text.match(/var\s+ct\s*=\s*(\d+)/);
                if (timestampMatch && timestampMatch[1]) {
                    const timestamp = Number.parseInt(timestampMatch[1], 10) * 1000;
                    const dateObj = new Date(timestamp);
                    if (!Number.isNaN(dateObj.getTime())) {
                        return dateObj.toISOString().split('T')[0];
                    }
                }

                const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
                if (dateMatch) {
                    return dateMatch[1];
                }
            }
        } catch (error) {
            console.error('Error extracting WeChat date:', error);
        }

        const publishTime = document.querySelector('#publish_time')?.textContent.trim() || '';
        const zhMatch = publishTime.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (zhMatch) {
            const [, year, month, day] = zhMatch;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }

        const isoMatch = publishTime.match(/(\d{4}-\d{2}-\d{2})/);
        return isoMatch ? isoMatch[1] : publishTime;
    };

    const extractWechatMetadata = () => {
        const title = document.querySelector('h1#activity-name')?.textContent.trim() ||
                      document.querySelector('h1.activity_title')?.textContent.trim() ||
                      document.querySelector('h1.rich_media_title')?.textContent.trim() ||
                      'Untitled';
        const content = document.querySelector('div#js_content') ||
                        document.querySelector('div.rich_media_content');
        const author = document.querySelector('a#js_name')?.textContent.trim() ||
                       document.querySelector('span.rich_media_meta.rich_media_meta_nickname')?.textContent.trim() ||
                       document.querySelector('div#meta_content a')?.textContent.trim() ||
                       'Unknown';
        const date = extractWechatDate();
        const url = window.location.href;

        return { title, content, author, date, url };
    };

    const isLayoutTable = (table) => {
        if (!table || table.querySelector('th')) {
            return false;
        }

        if (!(table instanceof HTMLTableElement) || table.rows.length === 0) {
            return true;
        }

        return Array.from(table.rows).every(row => row.cells.length <= 1);
    };

    const prepareWechatContent = (content) => {
        if (!content) {
            return content;
        }

        content.querySelectorAll('img').forEach((img, index) => {
            const src = normalizeUrl(
                img.getAttribute('data-src') ||
                img.getAttribute('data-lazy-src') ||
                img.getAttribute('data-original') ||
                img.getAttribute('src')
            );

            if (src) {
                img.setAttribute('src', src);
            }

            if (!img.getAttribute('alt')) {
                img.setAttribute('alt', `wechat-image-${index + 1}`);
            }
        });

        content.querySelectorAll('a').forEach(link => {
            const href = normalizeUrl(link.getAttribute('href'));
            if (href) {
                link.setAttribute('href', href);
            }
        });

        content.querySelectorAll('table').forEach(table => {
            const text = table.textContent.replace(/\s+/g, ' ').trim();

            if (!text && !table.querySelector('img')) {
                table.remove();
                return;
            }

            if (isLayoutTable(table) &&
                text &&
                text.length <= 60 &&
                !table.querySelector('img, p, ul, ol, pre, blockquote, code')) {
                const heading = document.createElement('h2');
                heading.textContent = text;
                table.replaceWith(heading);
                return;
            }

            if (isLayoutTable(table)) {
                table.setAttribute('data-layout-table', 'true');
            }
        });

        return content;
    };

    const collectWechatImageAssets = (contentElement) => {
        if (!contentElement) {
            return [];
        }

        const seen = new Set();
        const assets = [];

        contentElement.querySelectorAll('img').forEach((img, index) => {
            const sourceUrl = normalizeUrl(
                img.getAttribute('data-src') ||
                img.getAttribute('data-lazy-src') ||
                img.getAttribute('data-original') ||
                img.getAttribute('src')
            );

            if (!sourceUrl || seen.has(sourceUrl)) {
                return;
            }

            seen.add(sourceUrl);

            const width = Number.parseInt(img.getAttribute('data-w') || img.getAttribute('width') || '0', 10);
            const ratio = Number.parseFloat(img.getAttribute('data-ratio') || '0');
            const height = width > 0 && ratio > 0 ? Math.round(width * ratio) : 0;

            assets.push({
                sourceUrl,
                alt: img.getAttribute('alt') || `wechat-image-${index + 1}`,
                width: width || 0,
                height,
            });
        });

        return assets;
    };

    // Create a Turndown service instance for HTML to Markdown conversion
    const createTurndownService = () => {
        const service = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            bulletListMarker: '-'
        });

        // Custom rules for Zhihu content
        // Handle math formulas
        service.addRule('mathFormulas', {
            filter: (node) => {
                return node.nodeName === 'SPAN' &&
                       node.classList.contains('ztext-math') &&
                       node.hasAttribute('data-tex');
            },
            replacement: (content, node) => {
                const formula = node.getAttribute('data-tex');
                if (formula.includes('\\tag')) {
                    return `\n$$${formula}$$\n`;
                } else {
                    return `$${formula}$`;
                }
            }
        });

        // Improve heading handling
        service.addRule('headings', {
            filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
            replacement: function (content, node) {
                const level = Number(node.nodeName.charAt(1));
                return `\n${'#'.repeat(level)} ${content}\n\n`;
            }
        });

        // Handle tables
        service.addRule('tables', {
            filter: ['table'],
            replacement: function(content, node) {
                if (node.getAttribute('data-layout-table') === 'true') {
                    const trimmedContent = content.replace(/\n{3,}/g, '\n\n').trim();
                    return trimmedContent ? `\n\n${trimmedContent}\n\n` : '\n\n';
                }

                // Create arrays to store each row of the table
                const rows = Array.from(node.querySelectorAll('tr'));
                if (rows.length === 0) return content;
                
                // Process each row
                const markdownRows = rows.map(row => {
                    // Get all cells in the row (th or td)
                    const cells = Array.from(row.querySelectorAll('th, td'));
                    // Convert each cell to text and trim whitespace
                    return '| ' + cells.map(cell => {
                        const cellText = cell.textContent.trim().replace(/\n/g, ' ');
                        return cellText || ' ';
                    }).join(' | ') + ' |';
                });
                
                // If the first row contains th elements, add a separator row
                if (rows[0] && rows[0].querySelector('th')) {
                    const headerCells = Array.from(rows[0].querySelectorAll('th'));
                    const separatorRow = '| ' + headerCells.map(() => '---').join(' | ') + ' |';
                    markdownRows.splice(1, 0, separatorRow);
                } else if (rows.length > 0) {
                    // If no header row but we have rows, add a separator after the first row anyway
                    const firstRowCells = Array.from(rows[0].querySelectorAll('td')).length;
                    const separatorRow = '| ' + Array(firstRowCells).fill('---').join(' | ') + ' |';
                    markdownRows.splice(1, 0, separatorRow);
                }
                
                return '\n\n' + markdownRows.join('\n') + '\n\n';
            }
        });

        return service;
    };

    // Process content for download
    const processContent = (title, contentElement, author, date, url, options = {}) => {
        if (!contentElement) {
            throw new Error('Content element not found');
        }

        // Clone the node to prevent modifying the page
        const content = contentElement.cloneNode(true);

        if (options.pageType === 'wechat') {
            prepareWechatContent(content);
        }

        // Remove style tags
        content.querySelectorAll('style').forEach(style => style.remove());

        // Remove lazy loaded images
        content.querySelectorAll('img.lazy').forEach(img => img.remove());

        let markdown;

        // Try to use TurndownService if available, otherwise use our simple converter
        if (isTurndownServiceAvailable()) {
            showProgress('Converting with TurndownService...');
            const turndownService = createTurndownService();
            markdown = turndownService.turndown(content.innerHTML);
        } else {
            showProgress('Using fallback converter...');
            // Pre-process for our simple converter
            markdown = simpleHtmlToMarkdown(content.innerHTML);
        }

        // Create the full markdown document
        let fullMarkdown = `# ${title}\n\n`;
        fullMarkdown += `**Author:** ${author}\n\n`;
        if (date) {
            fullMarkdown += `**Date:** ${date}\n\n`;
        }
        fullMarkdown += `**Link:** ${url}\n\n`;
        fullMarkdown += markdown;

        return fullMarkdown;
    };

    // Download markdown function
    const downloadMarkdownFile = (title, author, markdown, date) => {
        const filename = date ?
            getValidFilename(`(${date})${title}_${author}.md`) :
            getValidFilename(`${title}_${author}.md`);

        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';

        document.body.appendChild(a);
        a.click();

        // Clean up
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);

        return filename;
    };

    // Download article function
    const downloadArticle = async () => {
        try {
            showProgress('Processing article...');

            const title = document.querySelector('h1.Post-Title')?.textContent.trim() || 'Untitled';
            const content = document.querySelector('div.Post-RichTextContainer');
            const author = document.querySelector('div.AuthorInfo meta[itemprop="name"]')?.getAttribute('content') || 'Unknown';
            const date = getArticleDate('div.ContentItem-time');
            const url = window.location.href;

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download answer function
    const downloadAnswer = async () => {
        try {
            showProgress('Processing answer...');

            const title = document.querySelector('h1.QuestionHeader-title')?.textContent.trim() || 'Untitled';
            const content = document.querySelector('div.RichContent-inner');
            const author = document.querySelector('div.AuthorInfo meta[itemprop="name"]')?.getAttribute('content') || 'Unknown';
            const date = getArticleDate('div.ContentItem-time');
            const url = window.location.href;

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading answer:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download video function
    const downloadVideo = async () => {
        try {
            showProgress('Processing video...');

            const videoDataElement = document.querySelector('div.ZVideo-video');
            if (!videoDataElement) {
                throw new Error('Could not find video data');
            }

            const videoData = JSON.parse(videoDataElement.getAttribute('data-zop') || '{}');
            const title = videoData.title || 'Untitled Video';
            const author = videoData.authorName || 'Unknown';
            const date = getArticleDate('div.ZVideo-meta');
            const url = window.location.href;

            // For videos, we need to extract the video URL
            const scriptContent = document.querySelector('script#js-initialData')?.textContent;
            if (!scriptContent) {
                throw new Error('Could not find video data script');
            }

            const data = JSON.parse(scriptContent);
            const videoId = window.location.pathname.split('/').pop();
            let videoUrl = null;

            try {
                const videos = data.initialState.entities.zvideos;
                if (videos && videos[videoId] && videos[videoId].video && videos[videoId].video.playlist) {
                    const playlist = videos[videoId].video.playlist;
                    // Get the highest quality video
                    const qualities = Object.keys(playlist);
                    videoUrl = playlist[qualities[0]].playUrl;
                }
            } catch (error) {
                console.error('Error extracting video URL:', error);
            }

            if (!videoUrl) {
                throw new Error('Could not find video URL');
            }

            // Create a markdown file with video information
            const markdown = `# ${title}\n\n` +
                            `**Author:** ${author}\n\n` +
                            `**Date:** ${date}\n\n` +
                            `**Link:** ${url}\n\n` +
                            `**Video URL:** [Download Video](${videoUrl})\n\n` +
                            `Note: You can download the video by clicking the link above or copying the URL.`;

            // Download markdown file
            const filename = downloadMarkdownFile(title, author, markdown, date);

            // Open video in new tab for downloading
            window.open(videoUrl, '_blank');

            showProgress(`Downloaded info: ${filename}. Video opened in new tab.`, 5000);

        } catch (error) {
            console.error('Error downloading video:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download column function
    const downloadColumn = () => {
        alert('Column download is not supported in the browser extension. Please use the server application for downloading columns.');
    };

    // Download CSDN article function
    const downloadCsdnArticle = async () => {
        try {
            showProgress('Processing CSDN article...');

            const title = document.querySelector('h1.title-article')?.textContent.trim() || 'Untitled';
            const content = document.querySelector('div#content_views');
            const authorElement = document.querySelector('div.bar-content');
            let author = 'Unknown';
            let date = '';
            
            if (authorElement && authorElement.querySelectorAll('a').length > 0) {
                author = authorElement.querySelectorAll('a')[0].textContent.trim();
                // Try to get date from time element or text content
                const timeElement = authorElement.querySelector('span.time');
                if (timeElement) {
                    const dateMatch = timeElement.textContent.match(/(\d{4}-\d{2}-\d{2})/);
                    date = dateMatch ? dateMatch[1] : '';
                }
            }
            
            const url = window.location.href;

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading CSDN article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download CSDN category function
    const downloadCsdnCategory = () => {
        alert('CSDN Category download is not supported in the browser extension. Please use the server application for downloading categories.');
    };

    // Download WeChat article function
    const downloadWechatArticle = async () => {
        try {
            showProgress('Processing WeChat article...');

            const { title, content, author, date, url } = extractWechatMetadata();

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = processContent(title, content, author, date, url, { pageType: 'wechat' });

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading WeChat article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download Juejin article function
    const downloadJuejinArticle = async () => {
        try {
            showProgress('Processing Juejin article...');

            const title = document.querySelector('h1.article-title')?.textContent.trim() || 'Untitled';
            const content = document.querySelector('div.main');
            const authorElement = document.querySelector('span.name');
            let author = 'Unknown';
            if (authorElement) {
                author = authorElement.textContent.trim();
            }

            // Extract date from time element
            const date = document.querySelector('time.time')?.textContent.trim() || '';

            const url = window.location.href;

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading Juejin article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download LMSYS blog article function
    const downloadLmsysArticle = async () => {
        try {
            showProgress('Processing LMSYS blog article...');

            // Try multiple selectors for title - LMSYS stores title in meta
            let title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                        document.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
                        document.title?.split('|')[0]?.trim() ||
                        'Untitled';

            // Try multiple selectors for content - LMSYS uses Next.js
            let content = document.querySelector('article') ||
                          document.querySelector('[class*="markdown"]') ||
                          document.querySelector('[class*="prose"]') ||
                          document.querySelector('[class*="blog"]') ||
                          document.querySelector('[class*="post"]') ||
                          document.querySelector('main') ||
                          document.querySelector('div[class*="content"]');

            // If still not found, clone body and remove non-content elements
            if (!content) {
                content = document.body.cloneNode(true);
                // Remove common non-content elements
                content.querySelectorAll('nav, header, footer, script, style, iframe, .nav, .header, .footer, .menu').forEach(el => el.remove());
            }

            // Convert relative image URLs to absolute
            content.querySelectorAll('img').forEach(img => {
                const src = img.getAttribute('src');
                if (src && src.startsWith('/')) {
                    img.setAttribute('src', 'https://lmsys.org' + src);
                }
            });

            // Extract author and date from first paragraph (format: "by: Author, Jan 21, 2026")
            let author = 'LMSYS Team';
            let date = '';

            const firstParagraph = content?.querySelector('p');
            if (firstParagraph) {
                const text = firstParagraph.textContent.trim();
                const match = text.match(/^by:\s*(.+?)\s*,\s*([A-Za-z]+\s+\d+,\s*\d{4})/);
                if (match) {
                    author = match[1].trim();
                    date = match[2].trim();
                    // Remove this metadata paragraph
                    firstParagraph.remove();
                }
            }

            const url = window.location.href;

            // Process content
            const markdown = processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading LMSYS article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download generic docs article function
    const downloadDocsArticle = async () => {
        try {
            showProgress('Processing docs article...');

            // Extract title from multiple sources
            let title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                        document.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
                        document.querySelector('h1')?.textContent.trim() ||
                        document.title?.split('|')[0]?.split('-')[0]?.trim() ||
                        'Untitled';

            // Try multiple selectors for content
            let content = document.querySelector('article') ||
                          document.querySelector('[role="main"]') ||
                          document.querySelector('.document') ||
                          document.querySelector('.content') ||
                          document.querySelector('.markdown-body') ||
                          document.querySelector('main') ||
                          document.querySelector('div.body');

            // If still not found, clone body and remove non-content elements
            if (!content) {
                content = document.body.cloneNode(true);
                content.querySelectorAll('nav, header, footer, aside, .sidebar, .navigation, .menu, script, style').forEach(el => el.remove());
            }

            // Convert relative image URLs to absolute
            const baseUrl = window.location.origin;
            content.querySelectorAll('img').forEach(img => {
                const src = img.getAttribute('src');
                if (src && src.startsWith('/')) {
                    img.setAttribute('src', baseUrl + src);
                }
            });

            // Convert relative links to absolute
            content.querySelectorAll('a').forEach(link => {
                const href = link.getAttribute('href');
                if (href && href.startsWith('/')) {
                    link.setAttribute('href', baseUrl + href);
                }
            });

            const url = window.location.href;
            const author = 'Docs';
            const date = '';

            // Process content
            const markdown = processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading docs article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Show progress message
    const showProgress = (message, timeout = 0) => {
        let progress = document.querySelector('.zhihu-dl-progress');

        if (!progress) {
            progress = document.createElement('div');
            progress.className = 'zhihu-dl-progress';
            document.body.appendChild(progress);
        }

        progress.textContent = message;
        progress.style.display = 'block';

        if (timeout > 0) {
            setTimeout(() => {
                progress.style.display = 'none';
            }, timeout);
        }
    };

    // Simple HTML to Markdown converter as fallback if TurndownService fails to load
    const simpleHtmlToMarkdown = (html) => {
        let div = document.createElement('div');
        div.innerHTML = html;

        // Process headings
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
            div.querySelectorAll(tag).forEach(heading => {
                const level = parseInt(tag.substring(1));
                const text = heading.textContent.trim();
                const markdown = document.createTextNode(`\n${'#'.repeat(level)} ${text}\n\n`);
                heading.parentNode.replaceChild(markdown, heading);
            });
        });

        // Process bold text
        div.querySelectorAll('strong, b').forEach(bold => {
            const text = bold.textContent;
            const markdown = document.createTextNode(`**${text}**`);
            bold.parentNode.replaceChild(markdown, bold);
        });

        // Process italic text
        div.querySelectorAll('em, i').forEach(italic => {
            const text = italic.textContent;
            const markdown = document.createTextNode(`*${text}*`);
            italic.parentNode.replaceChild(markdown, italic);
        });

        // Process links
        div.querySelectorAll('a').forEach(link => {
            if (link.href) {
                const text = link.textContent || link.href;
                const markdown = document.createTextNode(`[${text}](${link.href})`);
                link.parentNode.replaceChild(markdown, link);
            }
        });

        // Process images
        div.querySelectorAll('img').forEach(img => {
            if (img.src) {
                const alt = img.alt || 'image';
                const markdown = document.createTextNode(`\n![${alt}](${img.src})\n`);
                img.parentNode.replaceChild(markdown, img);
            }
        });

        // Process paragraphs
        div.querySelectorAll('p').forEach(p => {
            const text = p.innerHTML.trim();
            if (text) {
                p.innerHTML = text + '\n\n';
            }
        });

        // Process code blocks
        div.querySelectorAll('pre').forEach(pre => {
            const code = pre.textContent.trim();
            const markdown = document.createTextNode(`\n\`\`\`\n${code}\n\`\`\`\n\n`);
            pre.parentNode.replaceChild(markdown, pre);
        });

        // Process inline code
        div.querySelectorAll('code').forEach(code => {
            if (code.parentNode.tagName !== 'PRE') {
                const text = code.textContent;
                const markdown = document.createTextNode(`\`${text}\``);
                code.parentNode.replaceChild(markdown, code);
            }
        });

        return div.textContent;
    };

    // Function to check if TurndownService is available and working
    const isTurndownServiceAvailable = () => {
        try {
            if (typeof TurndownService !== 'undefined') {
                // Try a simple conversion to verify it works
                const test = new TurndownService();
                test.turndown('<p>test</p>');
                return true;
            }
            return false;
        } catch (error) {
            console.error('TurndownService check failed:', error);
            return false;
        }
    };

    // Handle download based on page type
    const handleDownload = () => {
        const url = window.location.href;

        if (url.includes('zhuanlan.zhihu.com/p/')) {
            downloadArticle();
        } else if (url.includes('zhihu.com/question/') && url.includes('/answer/')) {
            downloadAnswer();
        } else if (url.includes('zhihu.com/zvideo/')) {
            downloadVideo();
        } else if (url.includes('zhihu.com/column/')) {
            downloadColumn();
        } else if (url.includes('blog.csdn.net') && url.includes('/article/')) {
            downloadCsdnArticle();
        } else if (url.includes('blog.csdn.net') && url.includes('/category_')) {
            downloadCsdnCategory();
        } else if (url.includes('mp.weixin.qq.com/s')) {
            downloadWechatArticle();
        } else if (url.includes('juejin.cn/post/')) {
            downloadJuejinArticle();
        } else if (url.includes('lmsys.org/blog/')) {
            downloadLmsysArticle();
        } else if (url.includes('docs.') || url.includes('/docs/')) {
            downloadDocsArticle();
        } else {
            alert('This page type is not supported for download.');
        }
    };

    // Detect page type based on URL
    const detectPageType = () => {
        const url = window.location.href;

        if (url.includes('zhuanlan.zhihu.com/p/')) {
            return 'article';
        } else if (url.includes('zhihu.com/question/') && url.includes('/answer/')) {
            return 'answer';
        } else if (url.includes('zhihu.com/zvideo/')) {
            return 'video';
        } else if (url.includes('blog.csdn.net') && url.includes('/article/')) {
            return 'csdn';
        } else if (url.includes('mp.weixin.qq.com/s')) {
            return 'wechat';
        } else if (url.includes('juejin.cn/post/')) {
            return 'juejin';
        } else if (url.includes('lmsys.org/blog/')) {
            return 'lmsys';
        } else if (url.includes('docs.') || url.includes('/docs/')) {
            return 'docs';
        }
        return 'unknown';
    };

    // Generate markdown content (returns the markdown text)
    const generateMarkdownContent = async () => {
        const pageType = detectPageType();

        switch (pageType) {
            case 'article':
                return generateArticleMarkdown();
            case 'answer':
                return generateAnswerMarkdown();
            case 'video':
                return generateVideoMarkdown();
            case 'csdn':
                return generateCsdnMarkdown();
            case 'wechat':
                return generateWechatMarkdown();
            case 'juejin':
                return generateJuejinMarkdown();
            case 'lmsys':
                return generateLmsysMarkdown();
            case 'docs':
                return generateDocsMarkdown();
            default:
                throw new Error('Unsupported page type');
        }
    };

    // Format markdown with metadata (already done by processContent, just return as-is)
    const formatMarkdown = (title, author, markdown, date, url) => {
        return markdown;
    };

    // Helper functions to generate markdown for each page type
    const generateArticleMarkdown = async () => {
        const title = document.querySelector('h1.Post-Title')?.textContent.trim() || 'Untitled';
        const content = document.querySelector('div.Post-RichTextContainer');
        const author = document.querySelector('div.AuthorInfo meta[itemprop="name"]')?.getAttribute('content') || 'Unknown';
        const date = getArticleDate('div.ContentItem-time');
        const url = window.location.href;

        if (!content) {
            throw new Error('Could not find content on this page');
        }

        const markdown = processContent(title, content, author, date, url);
        return formatMarkdown(title, author, markdown, date, url);
    };

    const generateAnswerMarkdown = async () => {
        const title = document.querySelector('h1.QuestionHeader-title')?.textContent.trim() ||
                     document.querySelector('div.QuestionHeader-main h1')?.textContent.trim() || 'Untitled';
        const content = document.querySelector('div.RichContent-inner');
        const author = document.querySelector('div.AuthorInfo-name')?.textContent.trim() || 'Unknown';
        const date = getArticleDate('span.ContentItem-time');
        const url = window.location.href;

        if (!content) {
            throw new Error('Could not find answer content on this page');
        }

        const markdown = processContent(title, content, author, date, url);
        return formatMarkdown(title, author, markdown, date, url);
    };

    const generateVideoMarkdown = async () => {
        const title = document.querySelector('h1.VideoTitle')?.textContent.trim() || 'Untitled';
        const author = document.querySelector('a.AuthorInfo-name')?.textContent.trim() || 'Unknown';
        const date = getArticleDate('span.VideoEntry-timeText');
        const videoUrl = document.querySelector('video.zd-video')?.src || document.querySelector('video')?.src || '';
        const url = window.location.href;

        let markdown = `# ${title}\n\n`;
        markdown += `**Author:** ${author}\n\n`;
        if (date) {
            markdown += `**Date:** ${date}\n\n`;
        }
        markdown += `**Video URL:** [Download Video](${videoUrl})\n\n`;
        markdown += `Note: You can download the video by clicking the link above or copying the URL.`;

        return formatMarkdown(title, author, markdown, date, url);
    };

    const generateCsdnMarkdown = async () => {
        const title = document.querySelector('h1.title-article')?.textContent.trim() || 'Untitled';
        const content = document.querySelector('article.blog-content-box');
        const author = document.querySelector('a.follow-nickName')?.textContent.trim() || 'Unknown';
        const date = document.querySelector('span.time')?.textContent.trim().split(' ')[0] || '';
        const url = window.location.href;

        if (!content) {
            throw new Error('Could not find CSDN content');
        }

        const markdown = processContent(title, content, author, date, url);
        return formatMarkdown(title, author, markdown, date, url);
    };

    const generateWechatMarkdown = async () => {
        const { title, content, author, date, url } = extractWechatMetadata();

        if (!content) {
            throw new Error('Could not find WeChat content');
        }

        const markdown = processContent(title, content, author, date, url, { pageType: 'wechat' });
        return formatMarkdown(title, author, markdown, date, url);
    };

    const generateJuejinMarkdown = async () => {
        const title = document.querySelector('h1.article-title')?.textContent.trim() || 'Untitled';
        const content = document.querySelector('article.markdown-body');
        const author = document.querySelector('span.user-name')?.textContent.trim() || 'Unknown';
        const date = document.querySelector('span.meta-box')?.textContent.trim().match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
        const url = window.location.href;

        if (!content) {
            throw new Error('Could not find Juejin content');
        }

        const markdown = processContent(title, content, author, date, url);
        return formatMarkdown(title, author, markdown, date, url);
    };

    const generateLmsysMarkdown = async () => {
        // Extract title from meta tags (LMSYS uses Next.js with server-rendered meta)
        const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                      document.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
                      document.title?.split('|')[0]?.trim() ||
                      'Untitled';

        // Try multiple selectors for content - LMSYS uses Next.js
        let content = document.querySelector('article') ||
                       document.querySelector('[class*="markdown"]') ||
                       document.querySelector('[class*="prose"]') ||
                       document.querySelector('[class*="blog"]') ||
                       document.querySelector('[class*="post"]') ||
                       document.querySelector('main') ||
                       document.querySelector('div[class*="content"]');

        // If still not found, clone body and remove non-content elements
        if (!content) {
            content = document.body.cloneNode(true);
            content.querySelectorAll('nav, header, footer, script, style, iframe, .nav, .header, .footer, .menu').forEach(el => el.remove());
        }

        // Convert relative image URLs to absolute
        content.querySelectorAll('img').forEach(img => {
            const src = img.getAttribute('src');
            if (src && src.startsWith('/')) {
                img.setAttribute('src', 'https://lmsys.org' + src);
            }
        });

        const url = window.location.href;

        // Extract author and date from first paragraph
        let author = 'LMSYS Team';
        let date = '';

        if (content) {
            const firstParagraph = content.querySelector('p');
            if (firstParagraph) {
                const text = firstParagraph.textContent.trim();
                const match = text.match(/^by:\s*(.+?)\s*,\s*([A-Za-z]+\s+\d+,\s*\d{4})/);
                if (match) {
                    author = match[1].trim();
                    date = match[2].trim();
                }
            }
        }

        const markdown = processContent(title, content, author, date, url);
        return formatMarkdown(title, author, markdown, date, url);
    };

    const generateDocsMarkdown = async () => {
        // Extract title from multiple sources
        const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                      document.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
                      document.querySelector('h1')?.textContent.trim() ||
                      document.title?.split('|')[0]?.split('-')[0]?.trim() ||
                      'Untitled';

        // Try multiple selectors for content
        let content = document.querySelector('article') ||
                       document.querySelector('[role="main"]') ||
                       document.querySelector('.document') ||
                       document.querySelector('.content') ||
                       document.querySelector('.markdown-body') ||
                       document.querySelector('main') ||
                       document.querySelector('div.body');

        // If still not found, clone body and remove non-content elements
        if (!content) {
            content = document.body.cloneNode(true);
            content.querySelectorAll('nav, header, footer, aside, .sidebar, .navigation, .menu, script, style').forEach(el => el.remove());
        }

        // Convert relative image URLs to absolute
        const baseUrl = window.location.origin;
        content.querySelectorAll('img').forEach(img => {
            const src = img.getAttribute('src');
            if (src && src.startsWith('/')) {
                img.setAttribute('src', baseUrl + src);
            }
        });

        // Convert relative links to absolute
        content.querySelectorAll('a').forEach(link => {
            const href = link.getAttribute('href');
            if (href && href.startsWith('/')) {
                link.setAttribute('href', baseUrl + href);
            }
        });

        const url = window.location.href;
        const author = 'Docs';
        const date = '';

        const markdown = processContent(title, content, author, date, url);
        return formatMarkdown(title, author, markdown, date, url);
    };

    // Copy link function - uploads to GitHub Gist and copies the URL
    const copyMarkdownLink = async () => {
        try {
            // Check if Token exists first, if not, prompt for it
            let token = getGitHubToken();
            if (!token) {
                showProgress('需要 GitHub Token...');

                // Ask user what they want to do
                const choice = confirm(
                    '📝 首次使用需要 GitHub Token\n\n' +
                    '请选择：\n' +
                    '✅ 点击 "确定" - 打开 Token 创建页面（推荐）\n' +
                    '❌ 点击 "取消" - 手动输入已有 Token\n\n' +
                    '创建后请回到这里再次点击按钮'
                );

                if (choice) {
                    // User wants to create token
                    GM_openInTab('https://github.com/settings/tokens/new?scopes=gist&description=Zhihu2Markdown', {active: true});
                    showProgress('请创建 Token 后，再次点击此按钮粘贴 Token', 6000);
                    return;
                } else {
                    // User wants to paste token manually
                    const manualToken = prompt(
                        '🔑 请粘贴 GitHub Token\n\n' +
                        '1. 在打开的页面点击 "Generate token"\n' +
                        '2. 复制生成的 Token（开头是 ghp_）\n' +
                        '3. 粘贴到下方',
                        ''
                    );

                    if (manualToken) {
                        setGitHubToken(manualToken);
                        showProgress('Token 已保存！正在上传...', 2000);
                    } else {
                        showProgress('已取消。请通过 Tampermonkey 菜单设置 Token', 3000);
                        return;
                    }
                }
            }

            showProgress('Generating markdown...');

            // Generate markdown content
            const markdown = await generateMarkdownContent();

            // Generate filename
            const pageType = detectPageType();
            let title = 'Untitled';
            let author = 'Unknown';
            let date = '';
            let gistAssets = [];

            // Extract metadata based on page type
            if (pageType === 'article') {
                title = document.querySelector('h1.Post-Title')?.textContent.trim() || 'Untitled';
                author = document.querySelector('div.AuthorInfo meta[itemprop="name"]')?.getAttribute('content') || 'Unknown';
                date = getArticleDate('div.ContentItem-time') || '';
            } else if (pageType === 'answer') {
                title = document.querySelector('h1.QuestionHeader-title')?.textContent.trim() || 'Untitled';
                author = document.querySelector('div.AuthorInfo-name')?.textContent.trim() || 'Unknown';
                date = getArticleDate('span.ContentItem-time') || '';
            } else if (pageType === 'wechat') {
                const wechatMeta = extractWechatMetadata();
                title = wechatMeta.title;
                author = wechatMeta.author;
                date = wechatMeta.date || '';
                gistAssets = collectWechatImageAssets(wechatMeta.content);
            } else if (pageType === 'lmsys') {
                title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                        document.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
                        document.title?.split('|')[0]?.trim() ||
                        'Untitled';
                // Extract author and date from content
                const contentElement = document.querySelector('article') ||
                                     document.querySelector('[class*="markdown"]') ||
                                     document.querySelector('[class*="prose"]') ||
                                     document.querySelector('main');
                if (contentElement) {
                    const firstP = contentElement.querySelector('p');
                    if (firstP) {
                        const match = firstP.textContent.match(/^by:\s*(.+?)\s*,\s*([A-Za-z]+\s+\d+,\s*\d{4})/);
                        if (match) {
                            author = match[1].trim();
                            date = match[2].trim();
                        }
                    }
                }
                if (!author) author = 'LMSYS Team';
            } else if (pageType === 'docs') {
                title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                        document.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
                        document.querySelector('h1')?.textContent.trim() ||
                        document.title?.split('|')[0]?.split('-')[0]?.trim() ||
                        'Untitled';
                author = 'Docs';
            }

            const filename = date ?
                getValidFilename(`(${date})${title}_${author}.md`) :
                getValidFilename(`${title}_${author}.md`);

            // Upload to Gist
            const gistUrl = await uploadToGist(markdown, filename, gistAssets);

            // Copy Gist URL to clipboard
            await navigator.clipboard.writeText(gistUrl);

            // Show success message
            const copyButton = document.querySelector('.zhihu-copy-button');
            const originalText = copyButton.textContent;
            copyButton.textContent = '✓ Copied';

            setTimeout(() => {
                copyButton.textContent = originalText;
            }, 2000);

            showProgress('Gist URL copied! Open to view/download Markdown', 3000);
        } catch (error) {
            console.error('Error copying markdown link:', error);
            showProgress(`Error: ${error.message}`, 5000);
        }
    };

    // GitHub Gist API functions
    const GITHUB_GIST_API = 'https://api.github.com/gists';

    // Get GitHub Token from storage
    const getGitHubToken = () => {
        return GM_getValue('github_token', '');
    };

    // Save GitHub Token to storage
    const setGitHubToken = (token) => {
        GM_setValue('github_token', token);
    };

    const detectImageMimeType = (sourceUrl, contentType = '') => {
        if (contentType.startsWith('image/')) {
            return contentType.split(';')[0].trim();
        }

        const wxFmtMatch = sourceUrl.match(/[?&]wx_fmt=([a-zA-Z0-9]+)/i);
        if (wxFmtMatch && wxFmtMatch[1]) {
            const format = wxFmtMatch[1].toLowerCase();
            if (format === 'jpg') {
                return 'image/jpeg';
            }
            return `image/${format}`;
        }

        try {
            const pathname = new URL(sourceUrl).pathname.toLowerCase();
            if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
                return 'image/jpeg';
            }
            if (pathname.endsWith('.gif')) {
                return 'image/gif';
            }
            if (pathname.endsWith('.webp')) {
                return 'image/webp';
            }
            if (pathname.endsWith('.svg')) {
                return 'image/svg+xml';
            }
        } catch (error) {
            console.error('Error detecting image mime type:', error);
        }

        return 'image/png';
    };

    const escapeHtml = (value = '') => {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    const arrayBufferToBase64 = (buffer) => {
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = '';

        for (let index = 0; index < bytes.length; index += chunkSize) {
            const chunk = bytes.subarray(index, index + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }

        return btoa(binary);
    };

    const buildEmbeddedSvg = (base64, mimeType, asset) => {
        const widthAttr = asset.width ? ` width="${asset.width}"` : '';
        const heightAttr = asset.height ? ` height="${asset.height}"` : '';
        const viewBoxAttr = asset.width && asset.height ? ` viewBox="0 0 ${asset.width} ${asset.height}"` : '';

        return [
            `<svg xmlns="http://www.w3.org/2000/svg"${viewBoxAttr}${widthAttr}${heightAttr} role="img" aria-label="${escapeHtml(asset.alt)}">`,
            `  <image href="data:${mimeType};base64,${base64}" x="0" y="0" width="${asset.width || '100%'}" height="${asset.height || '100%'}" preserveAspectRatio="xMidYMid meet" />`,
            '</svg>',
        ].join('\n');
    };

    const fetchGistAssetFile = async (asset, fileName) => {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: asset.sourceUrl,
                responseType: 'arraybuffer',
                headers: {
                    'Referer': window.location.href,
                },
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`Failed to fetch image: ${response.status}`));
                        return;
                    }

                    try {
                        const mimeType = detectImageMimeType(asset.sourceUrl, response.responseHeaders?.match(/content-type:\s*([^\r\n]+)/i)?.[1] || '');
                        const base64 = arrayBufferToBase64(response.response);
                        resolve({
                            fileName,
                            sourceUrl: asset.sourceUrl,
                            content: buildEmbeddedSvg(base64, mimeType, asset),
                        });
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: () => {
                    reject(new Error('Network error while fetching image'));
                }
            });
        });
    };

    const requestGist = async (method, url, token, files, description) => {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                },
                data: JSON.stringify({
                    description,
                    files,
                }),
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(JSON.parse(response.responseText));
                    } else {
                        reject(new Error(`GitHub API Error: ${response.status} - ${response.responseText}`));
                    }
                },
                onerror: () => {
                    reject(new Error('Network error while uploading to Gist'));
                }
            });
        });
    };

    // Upload markdown to GitHub Gist (update if exists, create if not)
    const uploadToGist = async (markdown, filename, assets = []) => {
        const token = getGitHubToken();

        if (!token) {
            // Auto-open GitHub Token creation page
            GM_openInTab('https://github.com/settings/tokens/new?scopes=gist&description=Zhihu2Markdown', {active: true});
            throw new Error('请先创建 GitHub Token (新标签页已打开)，然后通过 Tampermonkey 菜单设置 Token');
        }

        showProgress('Checking existing gists...');

        // First, get all gists to check if file already exists
        const existingGistId = await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: GITHUB_GIST_API,
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        const gists = JSON.parse(response.responseText);

                        // Check if any gist has a file with the same name
                        for (const gist of gists) {
                            if (gist.files && gist.files[filename]) {
                                resolve(gist.id);
                                return;
                            }
                        }
                        resolve(null);
                    } else {
                        // If list fails, just create new
                        resolve(null);
                    }
                },
                onerror: () => {
                    // If list fails, just create new
                    resolve(null);
                }
            });
        });

        showProgress(existingGistId ? 'Updating existing gist...' : 'Creating new gist...');

        // Update existing gist or create new one
        const method = existingGistId ? 'PATCH' : 'POST';
        const url = existingGistId ? `${GITHUB_GIST_API}/${existingGistId}` : GITHUB_GIST_API;

        const files = {
            [filename]: {
                content: markdown
            }
        };

        const baseName = filename.replace(/\.md$/i, '');
        const assetFileMap = [];

        for (let index = 0; index < assets.length; index += 1) {
            const asset = assets[index];
            const assetFileName = getValidFilename(`${baseName}__img_${String(index + 1).padStart(2, '0')}.svg`);

            try {
                showProgress(`Embedding images for Gist (${index + 1}/${assets.length})...`);
                const assetFile = await fetchGistAssetFile(asset, assetFileName);
                files[assetFile.fileName] = { content: assetFile.content };
                assetFileMap.push({
                    fileName: assetFile.fileName,
                    sourceUrl: assetFile.sourceUrl,
                });
            } catch (error) {
                console.error(`Failed to embed image ${asset.sourceUrl}:`, error);
            }
        }

        let data = await requestGist(method, url, token, files, filename);
        let finalMarkdown = markdown;

        for (const asset of assetFileMap) {
            const rawUrl = data.files?.[asset.fileName]?.raw_url;
            if (rawUrl) {
                finalMarkdown = finalMarkdown.split(asset.sourceUrl).join(rawUrl);
            }
        }

        if (finalMarkdown !== markdown) {
            data = await requestGist('PATCH', `${GITHUB_GIST_API}/${data.id}`, token, {
                [filename]: {
                    content: finalMarkdown
                }
            }, filename);
        }

        return data.html_url;
    };

    // Show token input dialog
    const showTokenDialog = () => {
        const currentToken = getGitHubToken();

        const token = prompt(
            '🔑 GitHub Token 设置\n\n' +
            '还没有 Token？请按以下步骤创建：\n' +
            '1. 点击下方 "取消" 关闭此对话框\n' +
            '2. 点击 Tampermonkey 菜单中的 "📖 创建 GitHub Token"\n' +
            '3. 在打开的页面点击 "Generate token"\n' +
            '4. 复制 Token，再回到这里粘贴\n\n' +
            '已有 Token？直接粘贴到下方：\n\n' +
            '当前状态: ' + (currentToken ? '✅ 已设置' : '❌ 未设置') + '\n\n' +
            '留空可删除当前 Token',
            currentToken
        );

        if (token !== null) {
            setGitHubToken(token);
            if (token) {
                alert('✅ Token 已保存！现在可以使用 Copy Markdown Link 功能了');
            } else {
                alert('🗑️ Token 已删除');
            }
        }
    };

    // Open token creation page
    const openTokenCreation = () => {
        GM_openInTab('https://github.com/settings/tokens/new?scopes=gist&description=Zhihu2Markdown', {active: true});
    };

    // Register menu commands
    GM_registerMenuCommand('⚙️ 设置 GitHub Token', showTokenDialog);
    GM_registerMenuCommand('📖 创建 GitHub Token', openTokenCreation);

    // Add download button
    const addDownloadButton = () => {
        // Remove any existing buttons first
        const existingButton = document.querySelector('.zhihu-dl-button');
        if (existingButton) {
            existingButton.remove();
        }
        const existingCopyButton = document.querySelector('.zhihu-copy-button');
        if (existingCopyButton) {
            existingCopyButton.remove();
        }

        // Add copy button
        const copyButton = document.createElement('button');
        copyButton.textContent = '⬆️ Upload to My GitHub Gist';
        copyButton.className = 'zhihu-copy-button';
        copyButton.addEventListener('click', copyMarkdownLink);
        document.body.appendChild(copyButton);

        // Add download button
        const button = document.createElement('button');
        button.textContent = 'Download as Markdown';
        button.className = 'zhihu-dl-button';
        button.addEventListener('click', handleDownload);
        document.body.appendChild(button);
    };

    // Initialize
    const init = () => {
        // Add button after a short delay to ensure page is loaded
        setTimeout(addDownloadButton, 1500);

        // Re-add button when URL changes (for SPA navigation)
        let lastUrl = location.href;
        new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                lastUrl = url;
                setTimeout(addDownloadButton, 1500);
            }
        }).observe(document, {subtree: true, childList: true});
    };

    init();
})();
