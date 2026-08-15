from __future__ import annotations

import html
import re
from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    Image,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "docs" / "paper" / "fragrach-governance-compiler-draft_ja.md"
ASSETS = ROOT / "docs" / "paper" / "assets"
OUTPUT = ROOT / "output" / "pdf" / "fragrach-governance-compiler-arxiv-draft_ja.pdf"

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT = 22 * mm
RIGHT = 22 * mm
TOP = 20 * mm
BOTTOM = 19 * mm
CONTENT_WIDTH = PAGE_WIDTH - LEFT - RIGHT

INK = colors.HexColor("#14262A")
MUTED = colors.HexColor("#52656A")
ACCENT = colors.HexColor("#0B6B75")
ACCENT_DARK = colors.HexColor("#084B52")
PALE = colors.HexColor("#EAF3F4")
RULE = colors.HexColor("#A9BEC1")
TABLE_ALT = colors.HexColor("#F4F7F7")
PENDING = colors.HexColor("#FFF3D6")


def register_fonts() -> None:
    font_dir = Path("C:/Windows/Fonts")
    # ReportLab initializes every page with Helvetica even when no visible text uses it.
    # Register embedded substitutes so arXiv-style PDF preflight does not retain a
    # non-embedded Base-14 font resource.
    pdfmetrics.registerFont(
        TTFont("Helvetica", str(font_dir / "BIZ-UDGothicR.ttc"), subfontIndex=0)
    )
    pdfmetrics.registerFont(
        TTFont("Helvetica-Bold", str(font_dir / "BIZ-UDGothicB.ttc"), subfontIndex=0)
    )
    pdfmetrics.registerFont(
        TTFont("BIZMincho", str(font_dir / "BIZ-UDMinchoM.ttc"), subfontIndex=0)
    )
    pdfmetrics.registerFont(
        TTFont("BIZGothic", str(font_dir / "BIZ-UDGothicR.ttc"), subfontIndex=0)
    )
    pdfmetrics.registerFont(
        TTFont("BIZGothicBold", str(font_dir / "BIZ-UDGothicB.ttc"), subfontIndex=0)
    )
    pdfmetrics.registerFontFamily(
        "BIZMincho",
        normal="BIZMincho",
        bold="BIZGothicBold",
        italic="BIZMincho",
        boldItalic="BIZGothicBold",
    )
    pdfmetrics.registerFontFamily(
        "BIZGothic",
        normal="BIZGothic",
        bold="BIZGothicBold",
        italic="BIZGothic",
        boldItalic="BIZGothicBold",
    )


def make_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "TitleJP",
            parent=base["Title"],
            fontName="BIZGothicBold",
            fontSize=18.5,
            leading=25,
            textColor=INK,
            alignment=TA_CENTER,
            spaceAfter=7,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=base["Normal"],
            fontName="BIZGothic",
            fontSize=9.2,
            leading=13,
            textColor=MUTED,
            alignment=TA_CENTER,
            spaceAfter=9,
        ),
        "meta": ParagraphStyle(
            "Meta",
            parent=base["Normal"],
            fontName="BIZGothic",
            fontSize=9,
            leading=13,
            alignment=TA_CENTER,
            textColor=INK,
        ),
        "draft": ParagraphStyle(
            "Draft",
            parent=base["Normal"],
            fontName="BIZGothic",
            fontSize=8.6,
            leading=13,
            alignment=TA_LEFT,
            textColor=ACCENT_DARK,
            leftIndent=8,
            rightIndent=8,
            spaceBefore=4,
            spaceAfter=4,
        ),
        "abstract_label": ParagraphStyle(
            "AbstractLabel",
            parent=base["Heading2"],
            fontName="BIZGothicBold",
            fontSize=10.5,
            leading=14,
            textColor=ACCENT_DARK,
            alignment=TA_CENTER,
            spaceBefore=6,
            spaceAfter=5,
        ),
        "abstract": ParagraphStyle(
            "Abstract",
            parent=base["Normal"],
            fontName="BIZMincho",
            fontSize=8.8,
            leading=14.3,
            textColor=INK,
            alignment=TA_JUSTIFY,
            firstLineIndent=0,
            spaceAfter=7,
        ),
        "h1": ParagraphStyle(
            "Heading1JP",
            parent=base["Heading1"],
            fontName="BIZGothicBold",
            fontSize=14,
            leading=19,
            textColor=ACCENT_DARK,
            spaceBefore=12,
            spaceAfter=6,
            keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "Heading2JP",
            parent=base["Heading2"],
            fontName="BIZGothicBold",
            fontSize=11.2,
            leading=15,
            textColor=INK,
            spaceBefore=9,
            spaceAfter=4,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "BodyJP",
            parent=base["BodyText"],
            fontName="BIZMincho",
            fontSize=9.25,
            leading=15.1,
            textColor=INK,
            alignment=TA_JUSTIFY,
            firstLineIndent=9.25,
            spaceAfter=5.5,
            allowWidows=0,
            allowOrphans=0,
        ),
        "body_noindent": ParagraphStyle(
            "BodyNoIndent",
            parent=base["BodyText"],
            fontName="BIZMincho",
            fontSize=9.25,
            leading=15.1,
            textColor=INK,
            alignment=TA_JUSTIFY,
            firstLineIndent=0,
            spaceAfter=5.5,
        ),
        "bullet": ParagraphStyle(
            "BulletJP",
            parent=base["BodyText"],
            fontName="BIZMincho",
            fontSize=9.05,
            leading=14.5,
            textColor=INK,
            leftIndent=13,
            firstLineIndent=-8,
            bulletIndent=3,
            spaceAfter=3.2,
        ),
        "equation": ParagraphStyle(
            "Equation",
            parent=base["Normal"],
            fontName="BIZGothic",
            fontSize=9.2,
            leading=14,
            alignment=TA_CENTER,
            textColor=INK,
            spaceBefore=5,
            spaceAfter=7,
        ),
        "caption": ParagraphStyle(
            "Caption",
            parent=base["Normal"],
            fontName="BIZGothic",
            fontSize=7.8,
            leading=11.7,
            alignment=TA_LEFT,
            textColor=MUTED,
            spaceBefore=4,
            spaceAfter=9,
        ),
        "table": ParagraphStyle(
            "TableCell",
            parent=base["Normal"],
            fontName="BIZGothic",
            fontSize=7.55,
            leading=10.4,
            textColor=INK,
        ),
        "table_header": ParagraphStyle(
            "TableHeader",
            parent=base["Normal"],
            fontName="BIZGothicBold",
            fontSize=7.5,
            leading=10.2,
            textColor=colors.white,
            alignment=TA_CENTER,
        ),
        "reference": ParagraphStyle(
            "Reference",
            parent=base["Normal"],
            fontName="BIZMincho",
            fontSize=8.2,
            leading=12.5,
            textColor=INK,
            leftIndent=12,
            firstLineIndent=-12,
            spaceAfter=4,
        ),
    }


def normalize_math(text: str) -> str:
    text = re.sub(r"\\operatorname\{([^{}]+)\}", r"\1", text)
    text = re.sub(r"\\frac\{([^{}]+)\}\{([^{}]+)\}", r"(\1) / (\2)", text)
    text = re.sub(r"\\sum_\{([^{}]+)\}", r"Σ_{\1}", text)
    replacements = {
        r"\rightarrow": "→",
        r"\in": "∈",
        r"\land": "∧",
        r"\cdot": "·",
        r"\{": "{",
        r"\}": "}",
        r"\_": "_",
        r"\,": " ",
        r"\quad": "   ",
        r"\left": "",
        r"\right": "",
        r"\mathrm": "",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = text.replace("\\(", "").replace("\\)", "")
    text = text.replace("\\[", "").replace("\\]", "")
    return text.strip()


def inline(text: str) -> str:
    text = normalize_math(text)
    placeholders: dict[str, str] = {}

    def stash(value: str) -> str:
        key = f"@@TOKEN{len(placeholders)}@@"
        placeholders[key] = value
        return key

    text = re.sub(
        r"\[([^\]]+)\]\((https?://[^)]+)\)",
        lambda m: stash(
            f'<link href="{html.escape(m.group(2), quote=True)}" color="#0B6B75">'
            f"{html.escape(m.group(1))}</link>"
        ),
        text,
    )
    text = re.sub(
        r"`([^`]+)`",
        lambda m: stash(f'<font name="BIZGothic">{html.escape(m.group(1))}</font>'),
        text,
    )
    text = html.escape(text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", text)
    for key, value in placeholders.items():
        text = text.replace(key, value)
    return text


def parse_table(lines: list[str], start: int, styles: dict[str, ParagraphStyle]):
    raw_rows: list[list[str]] = []
    i = start
    while i < len(lines) and lines[i].strip().startswith("|"):
        raw_rows.append([cell.strip() for cell in lines[i].strip().strip("|").split("|")])
        i += 1
    if len(raw_rows) > 1 and all(re.fullmatch(r":?-{3,}:?", c) for c in raw_rows[1]):
        raw_rows.pop(1)
    ncols = max(len(row) for row in raw_rows)
    rows = []
    for row_index, row in enumerate(raw_rows):
        row += [""] * (ncols - len(row))
        style = styles["table_header"] if row_index == 0 else styles["table"]
        rows.append([Paragraph(inline(cell), style) for cell in row])

    if ncols == 2:
        widths = [CONTENT_WIDTH * 0.28, CONTENT_WIDTH * 0.72]
    elif ncols == 3:
        widths = [CONTENT_WIDTH * 0.21, CONTENT_WIDTH * 0.28, CONTENT_WIDTH * 0.51]
    elif ncols == 4 and raw_rows[0][0] == "指標":
        widths = [
            CONTENT_WIDTH * 0.12,
            CONTENT_WIDTH * 0.28,
            CONTENT_WIDTH * 0.32,
            CONTENT_WIDTH * 0.28,
        ]
    elif ncols == 4:
        widths = [CONTENT_WIDTH * 0.27] + [CONTENT_WIDTH * 0.2433] * 3
    elif ncols == 5:
        widths = [CONTENT_WIDTH * 0.32, CONTENT_WIDTH * 0.17, CONTENT_WIDTH * 0.17, CONTENT_WIDTH * 0.17, CONTENT_WIDTH * 0.17]
    else:
        widths = [CONTENT_WIDTH / ncols] * ncols

    table = Table(rows, colWidths=widths, repeatRows=1, hAlign="LEFT", splitByRow=1)
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), ACCENT_DARK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4.5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, ACCENT_DARK),
        ("LINEBELOW", (0, 1), (-1, -1), 0.3, RULE),
    ]
    for row_index in range(1, len(rows)):
        commands.append(
            ("BACKGROUND", (0, row_index), (-1, row_index), colors.white if row_index % 2 else TABLE_ALT)
        )
        if any("計測中" in cell or "未確定" in cell for cell in raw_rows[row_index]):
            commands.append(("BACKGROUND", (0, row_index), (-1, row_index), PENDING))
    table.setStyle(TableStyle(commands))
    return table, i


def scaled_image(path: Path, max_height: float = 235) -> Image:
    with PILImage.open(path) as source:
        width, height = source.size
    scale = min(CONTENT_WIDTH / width, max_height / height)
    return Image(str(path), width=width * scale, height=height * scale)


def header_footer(canvas, doc) -> None:
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.4)
    canvas.line(LEFT, PAGE_HEIGHT - 13.5 * mm, PAGE_WIDTH - RIGHT, PAGE_HEIGHT - 13.5 * mm)
    canvas.setFont("BIZGothic", 6.8)
    canvas.setFillColor(MUTED)
    canvas.drawString(LEFT, PAGE_HEIGHT - 10.8 * mm, "Fragrach — Dependency-aware Living Corpus RAG")
    canvas.drawRightString(PAGE_WIDTH - RIGHT, 10.8 * mm, f"{doc.page}")
    canvas.setTitle("Fragrach: RAGの前段で企業文書の効力を解決するガバナンス・コンパイラ")
    canvas.setAuthor("[Author Name]")
    canvas.setSubject("Preprint draft with scoped quantitative evaluation results")
    canvas.restoreState()


def cover_flowables(styles: dict[str, ParagraphStyle]):
    note = Table(
        [[Paragraph(
            "<b>投稿前ドラフト</b>　主要値は凍結済み実践holdoutと保存artifactから集計済みです。"
            "異なる企業文書構造への一般化は未確定です。",
            styles["draft"],
        )]],
        colWidths=[CONTENT_WIDTH],
    )
    note.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE),
        ("BOX", (0, 0), (-1, -1), 0.7, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return [
        Spacer(1, 5 * mm),
        Paragraph("Fragrach: RAGの前段で企業文書の効力を解決する<br/>ガバナンス・コンパイラ", styles["title"]),
        Paragraph("<b>Dependency-aware Living Corpus RAG</b>", styles["subtitle"]),
        Paragraph("Fragrach: A Governance Compiler for Resolving Enterprise Document Validity before Retrieval-Augmented Generation", styles["meta"]),
        HRFlowable(width="38%", thickness=0.8, color=ACCENT, spaceBefore=2, spaceAfter=7),
        Paragraph("著者: ［著者名］　　所属: ［所属］", styles["meta"]),
        Paragraph("Draft 0.2　2026-08-09", styles["meta"]),
        Spacer(1, 5),
        note,
        Spacer(1, 6),
    ]


def markdown_flowables(styles: dict[str, ParagraphStyle]):
    lines = SOURCE.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == "## 要旨")
    lines = lines[start:]
    story = []
    i = 0
    in_abstract = False
    in_references = False

    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped:
            i += 1
            continue

        if stripped == "## 要旨":
            in_abstract = True
            story.append(Paragraph("要旨", styles["abstract_label"]))
            i += 1
            continue

        if stripped.startswith("## "):
            in_abstract = False
            title = stripped[3:].strip()
            in_references = title == "参考文献"
            if in_references:
                story.append(PageBreak())
            story.append(Paragraph(inline(title), styles["h1"]))
            i += 1
            continue

        if stripped.startswith("### "):
            story.append(Paragraph(inline(stripped[4:].strip()), styles["h2"]))
            i += 1
            continue

        image_match = re.match(r"!\[([^\]]*)\]\(([^)]+)\)", stripped)
        if image_match:
            source_path = Path(image_match.group(2))
            asset = ASSETS / source_path.name
            if asset.suffix.lower() == ".svg":
                asset = asset.with_suffix(".png")
            image = scaled_image(asset)
            group = [Spacer(1, 5), image]
            if i + 1 < len(lines):
                j = i + 1
                while j < len(lines) and not lines[j].strip():
                    j += 1
                if j < len(lines) and lines[j].strip().startswith("**図"):
                    group.append(Paragraph(inline(lines[j].strip()), styles["caption"]))
                    i = j + 1
                else:
                    i += 1
            else:
                i += 1
            story.append(KeepTogether(group))
            continue

        if stripped.startswith("|"):
            table, i = parse_table(lines, i, styles)
            story.extend([Spacer(1, 4), KeepTogether([table]), Spacer(1, 7)])
            continue

        if stripped in (r"\[", "```math"):
            closing_delimiter = r"\]" if stripped == r"\[" else "```"
            equation = []
            i += 1
            while i < len(lines) and lines[i].strip() != closing_delimiter:
                equation.append(lines[i].strip())
                i += 1
            i += 1
            story.append(Paragraph(inline(" ".join(equation)), styles["equation"]))
            continue

        if stripped.startswith(">"):
            quote = stripped.lstrip("> ")
            story.append(Table(
                [[Paragraph(inline(quote), styles["body_noindent"]) ]],
                colWidths=[CONTENT_WIDTH - 12],
                style=TableStyle([
                    ("LINEBEFORE", (0, 0), (0, -1), 2, ACCENT),
                    ("LEFTPADDING", (0, 0), (-1, -1), 9),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ("BACKGROUND", (0, 0), (-1, -1), PALE),
                ]),
            ))
            story.append(Spacer(1, 5))
            i += 1
            continue

        bullet = re.match(r"^[-*]\s+(.+)$", stripped)
        numbered = re.match(r"^(\d+)\.\s+(.+)$", stripped)
        if bullet:
            story.append(Paragraph("• " + inline(bullet.group(1)), styles["bullet"]))
            i += 1
            continue
        if numbered:
            story.append(Paragraph(f"{numbered.group(1)}. " + inline(numbered.group(2)), styles["bullet"]))
            i += 1
            continue

        paragraph = [stripped]
        i += 1
        while i < len(lines):
            candidate = lines[i].strip()
            if not candidate:
                break
            if (
                candidate.startswith(("## ", "### ", "![", "|", ">", "- ", "* "))
                or candidate in (r"\[", "```math")
                or re.match(r"^\d+\.\s+", candidate)
            ):
                break
            paragraph.append(candidate)
            i += 1

        text = " ".join(paragraph)
        if in_references and re.match(r"^\[\d+\]", text):
            story.append(Paragraph(inline(text), styles["reference"]))
        elif in_abstract:
            story.append(Paragraph(inline(text), styles["abstract"]))
        else:
            story.append(Paragraph(inline(text), styles["body"]))

    return story


def build() -> None:
    register_fonts()
    styles = make_styles()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frame = Frame(
        LEFT,
        BOTTOM,
        CONTENT_WIDTH,
        PAGE_HEIGHT - TOP - BOTTOM,
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc = BaseDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        leftMargin=LEFT,
        rightMargin=RIGHT,
        topMargin=TOP,
        bottomMargin=BOTTOM,
        title="Fragrach: RAGの前段で企業文書の効力を解決するガバナンス・コンパイラ",
        author="[Author Name]",
        subject="Preprint draft with scoped quantitative evaluation results",
        pageTemplates=[PageTemplate(id="main", frames=[frame], onPage=header_footer)],
    )
    story = cover_flowables(styles) + markdown_flowables(styles)
    doc.build(story)
    print(OUTPUT)


if __name__ == "__main__":
    build()
