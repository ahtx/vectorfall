"""PDF text and word geometry through pdfminer.six (MIT licence).

pages(data) yields one Page per PDF page. Page.words() gives (x0, top, x1, bottom, text) tuples with the origin at
the top-left corner, so table code can sort rows from the top down. Page.text() gives the page's plain text.
"""
import io


class Encrypted(ValueError):
    pass


class Page:
    def __init__(self, layout):
        self._layout = layout
        self.height = layout.height

    def _lines(self):
        from pdfminer.layout import LTTextContainer, LTTextLine
        stack = list(self._layout)
        while stack:
            obj = stack.pop(0)
            if isinstance(obj, LTTextLine):
                yield obj
            elif isinstance(obj, LTTextContainer):
                stack[0:0] = list(obj)

    def words(self):
        from pdfminer.layout import LTChar
        out = []
        for line in self._lines():
            cur, box = [], None
            for ch in list(line) + [None]:
                text = ch.get_text() if ch is not None else " "
                if ch is None or not isinstance(ch, LTChar) or not text.strip():
                    if cur:
                        out.append((box[0], self.height - box[3], box[2], self.height - box[1], "".join(cur)))
                    cur, box = [], None
                    continue
                cur.append(text)
                b = ch.bbox
                box = list(b) if box is None else [min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3])]
        return out

    def text(self):
        return "\n".join(line.get_text().rstrip("\n") for line in self._lines())


def pages(data, max_pages=None):
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LAParams
    from pdfminer.pdfdocument import PDFPasswordIncorrect, PDFEncryptionError
    try:
        for i, layout in enumerate(extract_pages(io.BytesIO(data), laparams=LAParams())):
            if max_pages is not None and i >= max_pages:
                break
            yield Page(layout)
    except (PDFPasswordIncorrect, PDFEncryptionError) as ex:
        raise Encrypted("encrypted PDFs require decryption before extraction") from ex


def plain_text(data):
    return "\n\n".join(p.text() for p in pages(data))
