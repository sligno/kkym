# kkym

`kkym` is a Node-based CLI command to download and convert a Kakuyomu work (novel) into an EPUB structure for the purpose of private offline reading. The generated files may then be manually fine-tuned and zipped/packed to create a single EPUB or Kindle book.

This program has been developed for my personal use, only tested on a Windows environment with a few works of my own interests. It may not have much compatibility with other conditions.

<figure align="center">
  <img src="screenshot-kindle-previewer.jpg" width="600">
  <figcaption>Converted MOBI sample, open in Kindle Previewer (オルクセン王国史)</figcaption>
</figure>

## Install

This program is written in TypeScript and managed using [pnpm](https://pnpm.io/). The release tarball contains the compiled JS code and necessary assets. Download the tarball and install it with:

```
pnpm install -g <FULL-PATH>\kkym-<VERSION>.tgz
```

(Or npm equivalent could be used, hopefully.)

On Windows, `pnpm` may silently fail to create "bin" files (kkym, kkym.CMD) due to path/link related problems when trying to install from a local directory or a relative tarball path. To workaround this, make sure to specify the full path to the tarball.

## Basic Usage

```
kkym epubify <WORK-URL> --output <OUTPUT-DIR>
```

Where `<WORK-URL>` is a Kakuyomu work URL or ID. It can also be a local path to the work HTML file which could be downloaded by `kkym download` command.

After the output files are successfully generated, I would recommend reviewing and editing them to correct possible issues, such as missing a cover image, having too much extra spaces between lines and so on. Then you may want to create an EPUB file:

```
cd <OUTPUT-DIR>
zip -0X ..\<EPUB-FILE> mimetype
zip -9rDXJu ..\<EPUB-FILE> * -x mimetype
```

Or a Kindle book:

```
cd <OUTPUT-DIR>
kindlegen -c2 content.opf -o <MOBI-FILE>
```

## Customization

For now, customization of the output layout/formatting could be done by modifying the static assets in src/assets and [mustache](https://mustache.github.io/) templates in src/templates.

## Todo?

- Keep 1- or 2-digit numbers upright (horizontally) in vertical text.
- Make static assets overridable.

## Terms

- This program is intended to enable offline reading of Kakuyomu works in vertical text layout. The output content can only be used for private purposes. Reproduction, redistribution, commercial use, and any other acts of copyright infringement are prohibited.
- Do not use this command in a way to put load on the source servers.

## License

Copyright (C) 2026 SLigno (Sato).

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
