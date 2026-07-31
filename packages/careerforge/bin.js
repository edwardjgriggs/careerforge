#!/usr/bin/env node
/**
 * The unscoped name, which is the one people type.
 *
 * `npm install -g careerforge` has to resolve to something, and the package
 * that owns the code is scoped. So this is a name and a dependency and
 * nothing else: no argument handling, no exit-code logic, no second opinion
 * about anything. Everything it could get wrong lives in `@careerforge/cli`
 * and is tested there.
 *
 * Plain JavaScript on purpose. A four-line forwarder that needs a compiler is
 * four lines that can fail to build.
 */
import { main } from '@careerforge/cli';

await main(process.argv.slice(2));
