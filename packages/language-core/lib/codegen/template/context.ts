import type * as CompilerDOM from '@vue/compiler-dom';
import type { Code, VueCodeInformation } from '../../types';
import { codeFeatures } from '../codeFeatures';
import { InlayHintInfo } from '../inlayHints';
import { endOfLine, newLine, wrapWith } from '../utils';
import type { TemplateCodegenOptions } from './index';

export type TemplateCodegenContext = ReturnType<typeof createTemplateCodegenContext>;

export function createTemplateCodegenContext(options: Pick<TemplateCodegenOptions, 'scriptSetupBindingNames' | 'edited'>) {
	let ignoredError = false;
	let expectErrorToken: {
		errors: number;
		node: CompilerDOM.CommentNode;
	} | undefined;
	let lastGenericComment: {
		content: string;
		offset: number;
	} | undefined;
	let variableId = 0;

	function resolveCodeFeatures(features: VueCodeInformation) {
		if (features.verification) {
			if (ignoredError) {
				return {
					...features,
					verification: false,
				};
			}
			if (expectErrorToken) {
				const token = expectErrorToken;
				return {
					...features,
					verification: {
						shouldReport: () => {
							token.errors++;
							return false;
						},
					},
				};
			}
		}
		return features;
	}

	const hoistVars = new Map<string, string>();
	const localVars = new Map<string, number>();
	const specialVars = new Set<string>();
	const accessExternalVariables = new Map<string, Set<number>>();
	const slots: {
		name: string;
		offset?: number;
		tagRange: [number, number];
		nodeLoc: any;
		propsVar: string;
	}[] = [];
	const dynamicSlots: {
		expVar: string;
		propsVar: string;
	}[] = [];
	const blockConditions: string[] = [];
	const scopedClasses: {
		source: string;
		className: string;
		offset: number;
	}[] = [];
	const emptyClassOffsets: number[] = [];
	const inlayHints: InlayHintInfo[] = [];
	const bindingAttrLocs: CompilerDOM.SourceLocation[] = [];
	const inheritedAttrVars = new Set<string>();
	const templateRefs = new Map<string, {
		varName: string;
		offset: number;
	}>();

	return {
		codeFeatures: new Proxy(codeFeatures, {
			get(target, key: keyof typeof codeFeatures) {
				const data = target[key];
				return resolveCodeFeatures(data);
			},
		}),
		resolveCodeFeatures,
		slots,
		dynamicSlots,
		specialVars,
		accessExternalVariables,
		lastGenericComment,
		blockConditions,
		scopedClasses,
		emptyClassOffsets,
		inlayHints,
		bindingAttrLocs,
		inheritedAttrVars,
		templateRefs,
		currentComponent: undefined as {
			ctxVar: string;
			used: boolean;
		} | undefined,
		singleRootElType: undefined as string | undefined,
		singleRootNode: undefined as CompilerDOM.ElementNode | undefined,
		accessExternalVariable(name: string, offset?: number) {
			let arr = accessExternalVariables.get(name);
			if (!arr) {
				accessExternalVariables.set(name, arr = new Set());
			}
			if (offset !== undefined) {
				arr.add(offset);
			}
		},
		hasLocalVariable: (name: string) => {
			return !!localVars.get(name);
		},
		addLocalVariable: (name: string) => {
			localVars.set(name, (localVars.get(name) ?? 0) + 1);
		},
		removeLocalVariable: (name: string) => {
			localVars.set(name, localVars.get(name)! - 1);
		},
		getInternalVariable: () => {
			return `__VLS_${variableId++}`;
		},
		getHoistVariable: (originalVar: string) => {
			let name = hoistVars.get(originalVar);
			if (name === undefined) {
				hoistVars.set(originalVar, name = `__VLS_${variableId++}`);
			}
			return name;
		},
		generateHoistVariables: function* () {
			// trick to avoid TS 4081 (#5186)
			for (const [originalVar, hoistVar] of hoistVars) {
				yield `var ${hoistVar} = ${originalVar}${endOfLine}`;
			}
		},
		ignoreError: function* (): Generator<Code> {
			if (!ignoredError) {
				ignoredError = true;
				yield `// @vue-ignore start${newLine}`;
			}
		},
		expectError: function* (prevNode: CompilerDOM.CommentNode): Generator<Code> {
			if (!expectErrorToken) {
				expectErrorToken = {
					errors: 0,
					node: prevNode,
				};
				yield `// @vue-expect-error start${newLine}`;
			}
		},
		resetDirectiveComments: function* (endStr: string): Generator<Code> {
			if (expectErrorToken) {
				const token = expectErrorToken;
				yield* wrapWith(
					expectErrorToken.node.loc.start.offset,
					expectErrorToken.node.loc.end.offset,
					{
						verification: {
							shouldReport: () => token.errors === 0,
						},
					},
					`// @ts-expect-error __VLS_TS_EXPECT_ERROR`
				);
				yield `${newLine}${endOfLine}`;
				expectErrorToken = undefined;
				yield `// @vue-expect-error ${endStr}${newLine}`;
			}
			if (ignoredError) {
				ignoredError = false;
				yield `// @vue-ignore ${endStr}${newLine}`;
			}
		},
		generateAutoImportCompletion: function* (): Generator<Code> {
			if (!options.edited) {
				return;
			}
			const all = [...accessExternalVariables.entries()];
			if (!all.some(([_, offsets]) => offsets.size)) {
				return;
			}
			yield `// @ts-ignore${newLine}`; // #2304
			yield `[`;
			for (const [varName, offsets] of all) {
				for (const offset of offsets) {
					if (options.scriptSetupBindingNames.has(varName)) {
						// #3409
						yield [
							varName,
							'template',
							offset,
							{
								...codeFeatures.additionalCompletion,
								...codeFeatures.withoutHighlightAndCompletionAndNavigation,
							},
						];
					}
					else {
						yield [
							varName,
							'template',
							offset,
							codeFeatures.additionalCompletion,
						];
					}
					yield `,`;
				}
				offsets.clear();
			}
			yield `]${endOfLine}`;
		}
	};
}
