# UFI-TOOLS 插件源 JSON 规范

插件源地址必须返回 JSON。

## 基础结构

```json
{
  "download_url": "https://example.com/plugins",
  "res": {
    "code": 200,
    "message": "success",
    "data": {
      "content": []
    }
  }
}
```

## 字段要求

### download_url

插件文件下载根地址。

客户端会通过以下规则拼接插件下载地址：

```txt
download_url + "/" + name
```

例如：

```txt
https://example.com/plugins/hello.js
```

------

### res.code

状态码。

成功时应为：

```json
200
```

------

### res.message

状态信息。

成功时建议为：

```json
"success"
```

------

### res.data.content

插件列表数组。

每个插件对象至少需要包含：

```json
{
  "name": "hello.js",
  "modified": "2026-06-06T00:00:00+08:00",
  "hash_info": {
    "md5": "可选"
  }
}
```

## 插件对象字段

| 字段          | 类型    | 必填 | 说明                             |
| ------------- | ------- | ---- | -------------------------------- |
| name          | string  | 是   | 插件文件名，用于显示、搜索、下载 |
| modified      | string  | 建议 | 最后修改时间，用于显示           |
| hash_info.md5 | string  | 否   | MD5，用于显示                    |
| size          | number  | 否   | 文件大小                         |
| is_dir        | boolean | 否   | 是否目录，插件建议为 false       |

## 最小可用示例

```json
{
  "download_url": "https://example.com/plugins",
  "res": {
    "code": 200,
    "message": "success",
    "data": {
      "content": [
        {
          "name": "hello.js",
          "modified": "2026-06-06T00:00:00+08:00",
          "hash_info": {
            "md5": "d41d8cd98f00b204e9800998ecf8427e"
          }
        }
      ]
    }
  }
}
```

## 注意事项

1. `name` 必须是实际可下载的文件名。
2. 插件下载地址必须能通过 `download_url/name` 访问。
3. `content` 为空时，客户端会显示未找到插件。
4. 建议只返回 `.js` 插件文件，不返回目录。
5. `modified` 建议使用 ISO 时间格式。