# -*- coding: utf-8 -*-
import os
import re
import logging
import requests
from bs4 import BeautifulSoup
from markdownify import markdownify as md
from utils.util import insert_new_line, get_valid_filename


class LMSYSParser:
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
        self.soup = None
        self.logger = logging.getLogger('lmsys_parser')

        if self.keep_logs:
            self.logger.setLevel(logging.INFO)
            if not self.logger.handlers and not os.path.exists('./logs'):
                os.makedirs('./logs', exist_ok=True)

            if not self.logger.handlers:
                handler = logging.FileHandler(
                    './logs/lmsys_download.log', encoding='utf-8')
                formatter = logging.Formatter(
                    '%(asctime)s - %(levelname)s - %(message)s')
                handler.setFormatter(formatter)
                self.logger.addHandler(handler)
        else:
            self.logger.setLevel(logging.CRITICAL + 1)

    def log(self, level, message):
        """自定义日志函数，只在keep_logs为True时记录"""
        if self.keep_logs:
            if level == 'info':
                self.logger.info(message)
            elif level == 'warning':
                self.logger.warning(message)
            elif level == 'error':
                self.logger.error(message)

    def check_connect_error(self, target_link):
        """
        检查是否连接错误
        """
        try:
            response = self.session.get(target_link, timeout=30)
            response.raise_for_status()
        except requests.exceptions.HTTPError as err:
            self.log('error', f"HTTP error occurred: {err}")
            raise
        except requests.exceptions.RequestException as err:
            self.log('error', f"Error occurred: {err}")
            raise

        self.soup = BeautifulSoup(response.content, "html.parser")

    def judge_type(self, target_link):
        """
        判断url类型并解析
        """
        try:
            title = self.parse_article(target_link)
            return title
        except Exception as e:
            self.log('error', f"Error processing URL {target_link}: {str(e)}")
            raise

    def extract_author_and_date(self, content_element):
        """
        从文章开头提取作者和日期信息
        LMSYS 博客格式: "by: Author Name, Jan 26, 2026"
        """
        author = "LMSYS Team"
        date = None

        # 查找文章开头的段落
        first_paragraph = content_element.find('p')
        if first_paragraph:
            text = first_paragraph.get_text(strip=True)
            # 匹配 "by: ..." 格式
            by_pattern = r'^by:\s*(.+?)\s*,\s*([A-Za-z]+\s+\d+,\s*\d{4})'
            match = re.match(by_pattern, text)
            if match:
                author = match.group(1).strip()
                date = match.group(2).strip()
                # 移除这个元数据段落，避免重复
                first_paragraph.decompose()
                self.log('info', f"Extracted author: {author}, date: {date}")

        return author, date

    def save_and_transform(self, title, content_element, author, date, target_link):
        """
        转化并保存为 Markdown 格式文件
        """
        # 清理文件名
        markdown_title = get_valid_filename(title)

        if date:
            markdown_title = f"({date}){markdown_title}_{author}"
        else:
            markdown_title = f"{markdown_title}_{author}"

        if content_element is not None:
            # 移除样式标签
            for style_tag in content_element.find_all("style"):
                style_tag.decompose()

            # 移除 script 标签
            for script_tag in content_element.find_all("script"):
                script_tag.decompose()

            # 处理代码块 - 保留语言标记
            for pre in content_element.find_all("pre"):
                code = pre.find("code")
                if code:
                    # 获取语言 class (如 language-python)
                    lang_class = None
                    if code.get("class"):
                        for cls in code.get("class", []):
                            if cls.startswith("language-"):
                                lang_class = cls.replace("language-", "")
                                break

                    # 获取代码内容
                    code_text = code.get_text()

                    # 转换为 markdown 代码块格式
                    if lang_class:
                        markdown_code = f"\n```{lang_class}\n{code_text}\n```\n"
                    else:
                        markdown_code = f"\n```\n{code_text}\n```\n"

                    insert_new_line(self.soup, pre, 1)
                    pre.replace_with(markdown_code)

            # 处理图片 - 保留原始链接（不下载）
            for img in content_element.find_all("img"):
                try:
                    if 'src' in img.attrs:
                        img_url = img.attrs['src']
                        alt_text = img.get('alt', '')

                        # 保留原始链接作为 markdown 图片格式
                        if alt_text:
                            markdown_img = f"![{alt_text}]({img_url})"
                        else:
                            markdown_img = f"![]({img_url})"

                        insert_new_line(self.soup, img, 1)
                        img.replace_with(markdown_img)
                except Exception as e:
                    self.log('warning', f"Error processing image: {str(e)}")

            # 处理链接
            for link in content_element.find_all("a"):
                if 'href' in link.attrs:
                    href = link.attrs['href']
                    text = link.get_text(strip=True)
                    markdown_link = f"[{text}]({href})"
                    link.replace_with(markdown_link)

            # 处理标题
            for header in content_element.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
                header_level = int(header.name[1])
                header_text = header.get_text(strip=True)
                markdown_header = f"{'#' * header_level} {header_text}"
                insert_new_line(self.soup, header, 1)
                header.replace_with(markdown_header)

            # 处理引用块
            for blockquote in content_element.find_all("blockquote"):
                text = blockquote.get_text(strip=True)
                markdown_quote = f"> {text}"
                insert_new_line(self.soup, blockquote, 1)
                blockquote.replace_with(markdown_quote)

            # 处理列表
            for ul in content_element.find_all("ul"):
                items = ul.find_all("li", recursive=False)
                markdown_list = ""
                for li in items:
                    text = li.get_text(strip=True)
                    markdown_list += f"- {text}\n"
                insert_new_line(self.soup, ul, 1)
                ul.replace_with(markdown_list)

            for ol in content_element.find_all("ol"):
                items = ol.find_all("li", recursive=False)
                markdown_list = ""
                for idx, li in enumerate(items, 1):
                    text = li.get_text(strip=True)
                    markdown_list += f"{idx}. {text}\n"
                insert_new_line(self.soup, ol, 1)
                ol.replace_with(markdown_list)

            # 获取文本内容
            content = content_element.decode_contents().strip()
            # 转换为 markdown
            content = md(content)

        else:
            content = ""

        # 构建最终 markdown
        metadata = []
        metadata.append(f"# {title}")
        metadata.append("")
        metadata.append(f"**Author:** {author}")
        if date:
            metadata.append(f"**Date:** {date}")
        metadata.append(f"**Link:** {target_link}")
        metadata.append("")
        metadata.append("---")

        markdown = "\n".join(metadata) + "\n\n" + content

        # 保存 Markdown 文件
        with open(f"{markdown_title}.md", "w", encoding="utf-8") as f:
            f.write(markdown)

        return markdown_title

    def parse_article(self, target_link):
        """
        解析 LMSYS 博客文章并保存为 Markdown 格式文件
        """
        try:
            self.check_connect_error(target_link)

            # 提取标题 - 尝试多种方式
            title = None

            # 方式1: 从 meta og:title 获取
            og_title = self.soup.find("meta", property="og:title")
            if og_title and og_title.get("content"):
                title = og_title["content"]
                self.log('info', f"Found title from og:title: {title}")

            # 方式2: 从 meta twitter:title 获取
            if not title:
                twitter_title = self.soup.find("meta", attrs={"name": "twitter:title"})
                if twitter_title and twitter_title.get("content"):
                    title = twitter_title["content"]
                    self.log('info', f"Found title from twitter:title: {title}")

            # 方式3: 从 h1 标签获取
            if not title:
                h1 = self.soup.find("h1")
                if h1:
                    title = h1.get_text(strip=True)
                    self.log('info', f"Found title from h1: {title}")

            # 方式4: 从 title 标签获取
            if not title:
                title_tag = self.soup.find("title")
                if title_tag:
                    title = title_tag.get_text(strip=True).replace(" | LMSYS Org", "")
                    self.log('info', f"Found title from title tag: {title}")

            if not title:
                title = "Untitled"
                self.log('warning', "Could not find article title")

            # 提取文章内容
            # LMSYS 使用 Next.js，内容可能在不同的容器中
            content_element = None

            # 尝试常见的内容容器选择器
            content_selectors = [
                "article",
                "div.blog-content",
                "div.post-content",
                "div.content",
                "main",
                "div.prose",
                '[class*="content"]',
                '[class*="article"]',
                '[class*="post"]',
            ]

            for selector in content_selectors:
                content_element = self.soup.select_one(selector)
                if content_element:
                    self.log('info', f"Found content with selector: {selector}")
                    break

            # 如果没找到特定容器，尝试获取整个 body 的主要内容
            if not content_element:
                self.log('warning', "Could not find specific content container, using body")
                content_element = self.soup.find("body")

            if not content_element:
                raise Exception("Could not find article content")

            # 提取作者和日期
            author, date = self.extract_author_and_date(content_element)

            # 转换并保存
            markdown_title = self.save_and_transform(
                title, content_element, author, date, target_link
            )

            self.log('info', f"Successfully parsed article: {markdown_title}")
            return markdown_title

        except Exception as e:
            self.log('error', f"Error parsing article {target_link}: {str(e)}")
            raise


if __name__ == "__main__":
    # 测试代码
    url = 'https://lmsys.org/blog/2026-01-26-int4-qat/'

    parser = LMSYSParser(keep_logs=True)
    result = parser.judge_type(url)
    print(f"Successfully parsed: {result}")
