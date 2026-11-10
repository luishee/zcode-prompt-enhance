"""最小 asar 读取器：解析 header JSON，按需提取文件。

为什么自己写：npm 的 asar CLI 在这个包上 extract-file 直接抛
"Cannot read properties of undefined (reading 'files')"，说明它的路径解析
与这个包的 header 结构不兼容；而 asar 头部格式本身很简单
（16 字节 pickle 前缀 + 对齐后的 JSON + 顺序数据块），几十行就能读。
"""

import json
import os
import struct
import sys
from pathlib import Path


class Asar:
    def __init__(self, path):
        self.path = str(path)
        self.fp = open(path, 'rb')
        # 实测字段含义（2026-11-10，与 tools/patch_zcode.py 的写入口径一致）：
        #   prefix[0:4]  = 4（第一段 pickle 的载荷长度）
        #   prefix[4:8]  = P + 8，P 为 JSON 区（含补零）总长
        #   prefix[8:12] = P + 4
        #   prefix[12:16]= L，JSON 真实字节数
        #   data_start   = 16 + P，等价于 8 + prefix[4:8]
        # 早先误把 prefix[8:12] 当成 JSON 长度（其实是 P+4），会多读 4 字节；
        # 只因 raw_decode 在 JSON 结束时即停止，才没暴露成错误。
        self.fp.seek(0)
        _, header_size, _, json_len = struct.unpack('<IIII', self.fp.read(16))
        raw = self.fp.read(json_len)
        self.header = json.loads(raw.decode('utf-8'))
        self.base = 8 + header_size
        self.file_size = os.fstat(self.fp.fileno()).st_size

    def close(self):
        """显式关闭。必须提供：Windows 上只要读句柄还开着，
        对同一个文件的 os.replace 就会报 PermissionError。"""
        if not self.fp.closed:
            self.fp.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def _node(self, rel):
        node = self.header
        for part in rel.replace('\\', '/').split('/'):
            if not part:
                continue
            node = node['files'].get(part)
            if node is None:
                return None
        return node

    def read(self, rel):
        node = self._node(rel)
        if node is None or 'offset' not in node:
            raise FileNotFoundError(rel)
        offset = int(node['offset'])
        size = int(node['size'])
        # 越界检查：头部偏移算错时，与其静默返回半截数据让人以为「内容不一致」，
        # 不如直接报出来，指向真正的原因。
        if offset < 0 or size < 0 or self.base + offset + size > self.file_size:
            raise ValueError(f'{rel} 的偏移越界：offset={offset} size={size} 文件={self.file_size}')
        self.fp.seek(self.base + offset)
        return self.fp.read(size)

    def find(self, suffix, root=''):
        """递归列出路径以 suffix 结尾的文件。

        注意：返回的必须是**相对 asar 根**的完整路径。早先返回相对 root 的路径，
        导致后续 read() 全部 FileNotFoundError 被调用方静默跳过，
        得出了「渲染层没有 enhance 代码」的错误结论。这里显式带上 root 前缀。
        """
        found = []
        node = self.header if not root else self._node(root)
        if node is None:
            raise FileNotFoundError(root)
        stack = [(root, node)]
        while stack:
            prefix, cur = stack.pop()
            for name, child in cur.get('files', {}).items():
                full = f'{prefix}/{name}'.lstrip('/')
                if 'files' in child:
                    stack.append((full, child))
                elif full.endswith(suffix):
                    found.append(full)
        return found


def iter_leaves(node, prefix=""):
    """遍历所有叶子条目，产出 (相对 asar 根的路径, 元数据)。"""
    for name, child in node.get("files", {}).items():
        full = f"{prefix}/{name}".lstrip("/")
        if "files" in child:
            yield from iter_leaves(child, full)
        else:
            yield full, child


if __name__ == '__main__':
    a = Asar(sys.argv[1])
    if len(sys.argv) > 2:
        data = a.read(sys.argv[2])
        if len(sys.argv) > 3:
            Path(sys.argv[3]).write_bytes(data)
            print(f'已写出 {sys.argv[3]} ({len(data)} bytes)')
        else:
            sys.stdout.buffer.write(data)
    else:
        print('文件总数:', len(a.find('')))