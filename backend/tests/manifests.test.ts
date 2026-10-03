/**
 * 包依赖 / 构建清单文件（2026-10-03 追加）：只做高亮与预览 —— 认得出语言、能读正文，
 * 但不进符号索引、不进语言分布、不进阅读路线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';
import { langForFile, specForFile } from '../src/languages';
import { manifestLangFor } from '../src/languages/manifests';
import { buildOverview } from '../src/indexer/insight';
import { buildRoutes } from '../src/indexer/guide';

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/demo\n\ngo 1.21\n',
  'go.sum': 'github.com/x/y v1.0.0 h1:abc=\n',
  'pom.xml': '<project><artifactId>demo</artifactId></project>\n',
  'demo.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup /></Project>\n',
  'build.gradle': "plugins { id 'java' }\n",
  'build.gradle.kts': 'plugins { java }\n',
  'build.sbt': 'name := "demo"\n',
  Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n",
  'app.gemspec': "Gem::Specification.new do |s|\n  s.name = 'app'\nend\n",
  'mix.exs': 'defmodule Demo.MixProject do\n  use Mix.Project\nend\n',
  'Package.swift': '// swift-tools-version:5.9\n',
  'requirements-dev.txt': 'pytest==8.0.0\n',
  'constraints.txt': 'urllib3<2\n',
  Pipfile: '[packages]\nflask = "*"\n',
  'Cargo.lock': '[[package]]\nname = "demo"\n',
  'composer.lock': '{}\n',
  'pubspec.lock': 'packages:\n  http:\n    version: "1.0.0"\n',
  '.npmrc': 'registry=https://registry.npmjs.org/\n',
  Makefile: 'all:\n\techo hi\n',
  'notes.txt': '普通文本，认不出语言\n',
  'src/main.go': 'package main\n\nfunc main() {}\n',
};

test('清单文件 → 着色语言（扩展名 / 文件名 / 模式）', () => {
  const cases: Array<[string, string]> = [
    ['go.mod', 'gomod'],
    ['sub/dir/go.sum', 'gomod'],
    ['pom.xml', 'xml'],
    ['src/App.csproj', 'xml'],
    ['Directory.Build.props', 'xml'],
    ['NuGet.config', 'xml'],
    ['build.gradle', 'groovy'],
    ['gradle/x.gradle', 'groovy'],
    ['build.gradle.kts', 'kotlin'],
    ['build.sbt', 'scala'],
    ['Gemfile', 'ruby'],
    ['app.gemspec', 'ruby'],
    ['ios/App.podspec', 'ruby'],
    ['mix.exs', 'elixir'],
    ['mix.lock', 'elixir'],
    ['Package.swift', 'swift'],
    ['requirements.txt', 'pip'],
    ['requirements-dev.txt', 'pip'],
    ['constraints.txt', 'pip'],
    ['Pipfile', 'toml'],
    ['Cargo.lock', 'toml'],
    ['poetry.lock', 'toml'],
    ['Pipfile.lock', 'json'],
    ['composer.lock', 'json'],
    ['pubspec.lock', 'yaml'],
    ['.npmrc', 'ini'],
    ['Makefile', 'makefile'],
    ['scripts/db.mk', 'makefile'],
  ];
  for (const [file, lang] of cases) {
    assert.equal(langForFile(file), lang, `${file} → ${lang}`);
  }
  assert.equal(langForFile('notes.txt'), 'plaintext');
  // 可索引的语言不被清单表抢走
  assert.equal(langForFile('src/main.go'), 'go');
  assert.equal(langForFile('package.json'), 'json');
  assert.equal(specForFile('go.mod'), null, '清单文件不是「可索引的语言」');
  assert.equal(manifestLangFor('src/main.go'), null, '普通源码不走清单表');
});

test('清单文件：能预览，但不进符号索引 / 语言分布 / 阅读路线', async () => {
  const fx = await makeProject(FILES);
  try {
    for (const file of ['go.mod', 'pom.xml', 'Gemfile', 'requirements-dev.txt', 'Makefile']) {
      assert.equal(fx.project.files.has(file), false, `${file} 不该进符号索引`);
      const text = await fx.project.readText(file);
      assert.ok(text && text.text.length > 0, `${file} 要能读到正文（预览）`);
      assert.equal(text.lang, langForFile(file), `${file} 预览时带对语言（高亮用）`);
    }

    // 文件树（/all-files）里带正确 lang，能点开
    const tree = fx.project.buildAllFileTree();
    const flat = new Map<string, { lang?: string; indexed?: boolean }>();
    const walk = (n: { path: string; type: string; lang?: string; indexed?: boolean; children?: unknown[] }) => {
      if (n.type === 'file') flat.set(n.path, n);
      for (const c of (n.children ?? []) as typeof n[]) {
        if (c.type === 'file') flat.set(c.path, c);
        else walk(c as never);
      }
    };
    walk(tree as never);
    assert.equal(flat.get('go.mod')?.lang, 'gomod');
    assert.equal(flat.get('pom.xml')?.lang, 'xml');
    assert.equal(flat.get('Makefile')?.lang, 'makefile');
    // 未经预览的清单文件不进任何索引/缓存（build.sbt 未被 readText 读过）
    assert.equal(flat.get('build.sbt')?.indexed, false);

    // 语言分布与阅读路线都不含清单文件（只算真正索引过的代码）
    const overview = await buildOverview(fx.project);
    const langs = overview.identity.langs.map((l) => l.lang);
    assert.deepEqual(langs, ['go'], '只有 src/main.go 进了语言分布');
    const route = buildRoutes(fx.project);
    const files = route.routes.flatMap((r) => r.steps.map((s) => s.file));
    assert.ok(!files.includes('go.mod') && !files.includes('Makefile'), '清单文件不进阅读路线');
  } finally {
    await fx.cleanup();
  }
});
