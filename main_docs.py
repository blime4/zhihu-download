# -*- coding: utf-8 -*-
"""
通用文档网站解析器
支持基于 Sphinx、GitBook、Docusaurus 等框架构建的文档网站
"""
import os
import re
import logging
import time
import requests
from bs4 import BeautifulSoup
from markdownify import markdownify as md
from urllib.parse import urljoin, urlparse
from utils.util import insert_new_line, get_valid_filename


class DocsParser:
    # 常见文档网站的域名模式
    DOCS_DOMAINS = [
        'docs.nvda.net.cn',
        'docs.pytorch.org',
        'docs.huggingface.co',
        'tensorflow.org',
        'keras.io',
        'docs.rs',
        'readthedocs.io',
        'docs.scipy.org',
        'docs.djangoproject.com',
        'docs.oracle.com',
        'developer.mozilla.org',
    ]

    def __init__(self, hexo_uploader=False, keep_logs=False):
        self.hexo_uploader = hexo_uploader
        self.session = requests.Session()
        self.keep_logs = keep_logs
        self.user_agents = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        self.headers = {
            'User-Agent': self.user_agents,
            'Accept-Language': 'en,zh-CN;q=0.9,zh;q=0.8',
        }
        self.session.headers.update(self.headers)
        self.logger = logging.getLogger('docs_parser')
        self.visited_urls = set()
        self.download_dir = None

        if self.keep_logs:
            self.logger.setLevel(logging.INFO)
            if not self.logger.handlers and not os.path.exists('./logs'):
                os.makedirs('./logs', exist_ok=True)

            if not self.logger.handlers:
                handler = logging.FileHandler(
                    './logs/docs_download.log', encoding='utf-8')
                formatter = logging.Formatter(
                    '%(asctime)s - %(levelname)s - %(message)s')
                handler.setFormatter(formatter)
                self.logger.addHandler(handler)
        else:
            self.logger.setLevel(logging.CRITICAL + 1)

    def log(self, level, message):
        if self.keep_logs:
            if level == 'info':
                self.logger.info(message)
            elif level == 'warning':
                self.logger.warning(message)
            elif level == 'error':
                self.logger.error(message)

    @staticmethod
    def is_docs_url(url):
        """判断是否为文档网站 URL"""
        parsed = urlparse(url)
        hostname = parsed.hostname or ''

        # 检查域名是否在已知列表中
        for domain in DocsParser.DOCS_DOMAINS:
            if domain in hostname:
                return True

        # 检查路径是否包含 docs
        path = parsed.path.lower()
        if '/docs/' in path or path.startswith('/docs'):
            return True

        return False

    def fetch_page(self, url):
        """获取页面内容"""
        try:
            response = self.session.get(url, timeout=30)
            response.raise_for_status()
            return BeautifulSoup(response.content, "html.parser")
        except requests.exceptions.RequestException as e:
            self.log('error', f"Error fetching {url}: {str(e)}")
            return None

    def extract_title(self, soup, url):
        """提取文档标题"""
        # 优先级: meta og:title > h1 > title tag
        title = (
            soup.find("meta", property="og:title") and
            soup.find("meta", property="og:title").get("content")
        ) or (
            soup.find("meta", attrs={"name": "twitter:title"}) and
            soup.find("meta", attrs={"name": "twitter:title"}).get("content")
        ) or (
            soup.find("h1") and
            soup.find("h1").get_text(strip=True)
        ) or (
            soup.find("title") and
            soup.find("title").get_text(strip=True).split('|')[0].strip()
        ) or "Untitled"

        # 清理标题
        title = re.sub(r'[\\/:*?"<>|]', '_', title)
        return title[:100]  # 限制长度

    def extract_content(self, soup, url):
        """提取文档主要内容"""
        # 尝试多种内容选择器
        content_selectors = [
            'article',
            'main',
            '[role="main"]',
            '.document',
            '.content',
            '.post-content',
            '.markdown-body',
            '.md',
            'div.document',
            'div.body',
            'div[role="main"]',
        ]

        content = None
        for selector in content_selectors:
            content = soup.select_one(selector)
            if content:
                self.log('info', f"Found content with selector: {selector}")
                break

        if not content:
            self.log('warning', f"Could not find specific content container for {url}")
            # Fallback to body, but remove navigation
            content = soup.find('body')

        if content:
            # 移除非内容元素
            for element in content.find_all(['nav', 'header', 'footer', 'aside', '.sidebar', '.navigation', '.menu']):
                element.decompose()

            # 移除脚本和样式
            for element in content.find_all(['script', 'style', 'link']):
                element.decompose()

        return content

    def extract_metadata(self, soup, content):
        """提取文档元数据（作者、日期等）"""
        metadata = {
            'author': 'Docs',
            'date': '',
            'description': '',
        }

        # 尝试提取描述
        desc = soup.find("meta", attrs={"name": "description"})
        if desc:
            metadata['description'] = desc.get('content', '')

        return metadata

    def preprocess_content(self, content, base_url):
        """预处理内容：处理图片、链接、代码块等"""
        if not content:
            return content

        # 处理图片 - 转换相对路径为绝对路径
        for img in content.find_all('img'):
            src = img.get('src') or img.get('data-src')
            if src:
                if src.startswith('/'):
                    img['src'] = urljoin(base_url, src)
                elif not src.startswith('http'):
                    img['src'] = urljoin(base_url, src)
                # 保留 alt 文本
                if not img.get('alt'):
                    img['alt'] = ''

        # 处理代码块 - 保留语言标记
        for pre in content.find_all('pre'):
            code = pre.find('code')
            if code:
                # 获取语言 class
                lang_class = None
                if code.get('class'):
                    for cls in code.get('class', []):
                        if cls.startswith('language-'):
                            lang_class = cls.replace('language-', '')
                            break
                        elif cls in ['python', 'javascript', 'java', 'cpp', 'c', 'bash', 'shell', 'json', 'yaml', 'xml', 'html', 'css']:
                            lang_class = cls
                            break

        # 处理链接
        for link in content.find_all('a'):
            href = link.get('href')
            if href:
                if href.startswith('/'):
                    link['href'] = urljoin(base_url, href)

        return content

    def find_related_links(self, soup, base_url):
        """发现相关文档链接（同一章节的其他页面）"""
        links = []

        # 常见的侧边栏/导航选择器
        nav_selectors = [
            '.sidebar a',
            '.nav-list a',
            '.toc a',
            '.table-of-contents a',
            'nav a',
            '[role="navigation"] a',
            '.menu a',
            '.docs-navigation a',
            '.sidebar-nav a',
            '.bd-sidebar a',
            '.wy-nav-side a',
        ]

        for selector in nav_selectors:
            nav_links = soup.select(selector)
            if nav_links and len(nav_links) > 1:
                for a in nav_links:
                    href = a.get('href')
                    if href and not href.startswith('#') and not href.startswith('javascript:'):
                        full_url = urljoin(base_url, href)
                        # 只收集同域名的链接
                        if urlparse(full_url).hostname == urlparse(base_url).hostname:
                            links.append(full_url)
                if links:
                    self.log('info', f"Found {len(links)} related links with selector: {selector}")
                    break

        return list(set(links))  # 去重

    def save_document(self, title, content, metadata, url, index=0):
        """保存单个文档为 Markdown"""
        if not content:
            return None

        # 生成文件名
        if index > 0:
            filename = get_valid_filename(f"{index:02d}_{title}")
        else:
            filename = get_valid_filename(title)

        # 预处理内容
        base_url = f"{urlparse(url).scheme}://{urlparse(url).hostname}"
        content = self.preprocess_content(content, base_url)

        # 转换为 Markdown
        markdown_content = md(content.decode_contents())

        # 构建完整 Markdown
        full_markdown = f"# {title}\n\n"
        full_markdown += f"**Source:** {url}\n\n"
        if metadata.get('description'):
            full_markdown += f"> {metadata['description']}\n\n"
        full_markdown += "---\n\n"
        full_markdown += markdown_content

        # 保存文件
        filepath = f"{filename}.md"
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(full_markdown)

        self.log('info', f"Saved document: {filepath}")
        return filepath

    def download_single(self, url):
        """下载单个文档"""
        soup = self.fetch_page(url)
        if not soup:
            raise Exception(f"Failed to fetch page: {url}")

        title = self.extract_title(soup, url)
        content = self.extract_content(soup, url)
        metadata = self.extract_metadata(soup, content)

        return self.save_document(title, content, metadata, url)

    def download_section(self, url, max_pages=50, delay=0.5):
        """下载整个文档章节"""
        self.log('info', f"Starting section download from: {url}")

        # 创建输出目录
        dir_name = get_valid_filename(f"docs_{int(time.time())}")
        os.makedirs(dir_name, exist_ok=True)
        old_cwd = os.getcwd()
        os.chdir(dir_name)
        self.download_dir = dir_name

        try:
            # 获取起始页面
            soup = self.fetch_page(url)
            if not soup:
                raise Exception(f"Failed to fetch page: {url}")

            # 保存起始页
            title = self.extract_title(soup, url)
            content = self.extract_content(soup, url)
            metadata = self.extract_metadata(soup, content)
            self.save_document(title, content, metadata, url, index=0)

            # 发现相关链接
            related_links = self.find_related_links(soup, url)
            self.visited_urls.add(url)

            # 下载相关页面
            index = 1
            for link in related_links[:max_pages-1]:
                if link in self.visited_urls:
                    continue

                self.log('info', f"Downloading: {link}")
                link_soup = self.fetch_page(link)
                if link_soup:
                    self.visited_urls.add(link)
                    link_title = self.extract_title(link_soup, link)
                    link_content = self.extract_content(link_soup, link)
                    link_metadata = self.extract_metadata(link_soup, link_content)
                    self.save_document(link_title, link_content, link_metadata, link, index=index)
                    index += 1

                # 礼貌延迟
                time.sleep(delay)

            return dir_name

        finally:
            os.chdir(old_cwd)

    def judge_type(self, target_link, max_pages=1):
        """
        判断 URL 类型并执行下载

        Args:
            target_link: 目标 URL
            max_pages: 最大下载页数，1 表示单页，>1 表示章节下载
        """
        try:
            if max_pages == 1:
                return self.download_single(target_link)
            else:
                return self.download_section(target_link, max_pages=max_pages)
        except Exception as e:
            self.log('error', f"Error processing {target_link}: {str(e)}")
            raise


if __name__ == "__main__":
    # 测试代码
    test_urls = [
        'https://docs.nvda.net.cn/deeplearning/transformer-engine/user-guide/examples/fp8_primer.html',
        'https://docs.pytorch.org/',
    ]

    parser = DocsParser(keep_logs=True)

    for url in test_urls:
        print(f"\nTesting: {url}")
        if DocsParser.is_docs_url(url):
            print("-> Detected as docs URL")
            try:
                result = parser.judge_type(url, max_pages=1)
                print(f"-> Result: {result}")
            except Exception as e:
                print(f"-> Error: {e}")
        else:
            print("-> Not a docs URL")
