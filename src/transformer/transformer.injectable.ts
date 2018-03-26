import * as ts from 'typescript';
import { TransformUtil, Import, State } from '@travetto/compiler';
import { ConfigLoader } from '@travetto/config';

const INJECTABLES = TransformUtil.buildImportAliasMap({
  ...ConfigLoader.get('registry.injectable'),
  '@travetto/di': 'Injectable'
});

interface DiState extends State {
  inInjectable: boolean;
  decorators: { [key: string]: ts.Expression };
  import?: ts.Identifier
}

function processDeclaration(state: State, param: ts.ParameterDeclaration | ts.PropertyDeclaration) {
  const injection = TransformUtil.findAnyDecorator(param, { Inject: new Set(['@travetto/di']) }, state);

  if (injection || ts.isParameter(param)) {
    const finalTarget = TransformUtil.importIfExternal(param.type!, state);
    const injectConfig = TransformUtil.getPrimaryArgument<ts.ObjectLiteralExpression>(injection);

    let optional = TransformUtil.getObjectValue(injectConfig, 'optional');

    if (optional === undefined && !!param.questionToken) {
      optional = ts.createFalse();
    }

    return TransformUtil.fromLiteral({
      target: finalTarget,
      optional,
      qualifier: TransformUtil.getObjectValue(injectConfig, 'qualifier')
    });
  }
}

function createInjectDecorator(state: DiState, name: string, contents?: ts.Expression) {
  if (!state.decorators[name]) {
    if (!state.import) {
      state.import = ts.createIdentifier(`import_Injectable`);
      state.newImports.push({
        ident: state.import,
        path: require.resolve('../decorator/injectable')
      });
    }
    const ident = ts.createIdentifier(name);
    state.decorators[name] = ts.createPropertyAccess(state.import, ident);
  }
  return ts.createDecorator(
    ts.createCall(
      state.decorators[name],
      undefined,
      contents ? [contents] : []
    )
  );
}

function visitNode<T extends ts.Node>(context: ts.TransformationContext, node: T, state: DiState): T {
  if (ts.isClassDeclaration(node)) {
    const foundDec = TransformUtil.findAnyDecorator(node, INJECTABLES, state);

    if (foundDec) { // Constructor
      let decls = node.decorators;

      node = ts.visitEachChild(node, c => visitNode(context, c, state), context);

      const declTemp = (node.decorators || []).slice(0);
      const cons = (node as any as ts.ClassDeclaration).members.find(x => ts.isConstructorDeclaration(x)) as ts.ConstructorDeclaration;
      let injectArgs = undefined;

      if (cons) {
        try {
          injectArgs = TransformUtil.fromLiteral(cons.parameters.map(x => processDeclaration(state, x)));
        } catch (e) {
          // If error, skip
          if (e.message !== 'Type information not found') {
            throw e;
          }
        }
      }

      declTemp.push(createInjectDecorator(state, 'InjectArgs', injectArgs));

      // Add injectable decorator if not there (for aliased decorators)
      let injectable = TransformUtil.findAnyDecorator(node, { Injectable: new Set(['@travetto/di']) }, state);
      if (!injectable) {
        injectable = createInjectDecorator(state, 'Injectable');
        declTemp.push(injectable);
      }

      decls = ts.createNodeArray(declTemp);
      const cNode = node as any as ts.ClassDeclaration;
      const ret = ts.updateClassDeclaration(cNode,
        decls,
        cNode.modifiers,
        cNode.name,
        cNode.typeParameters,
        ts.createNodeArray(cNode.heritageClauses),
        cNode.members
      ) as any;

      return ret;
    }
  } else if (ts.isPropertyDeclaration(node)) { // Property
    const expr = processDeclaration(state, node);

    if (expr) {
      const final = createInjectDecorator(state, 'Inject', expr);
      const finalDecs = ((node.decorators as any as ts.Decorator[]) || [])
        .filter(x => TransformUtil.getDecoratorIdent(x).text !== 'Inject');

      // Doing decls
      const ret = ts.updateProperty(
        node,
        ts.createNodeArray([final, ...finalDecs]),
        node.modifiers,
        node.name,
        node.questionToken,
        node.type,
        node.initializer
      ) as any;
      ret.parent = node.parent;
      return ret;
    } else {
      return node;
    }
  } else if (ts.isMethodDeclaration(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) > 0) { // tslint:disable-line no-bitwise
    // Factory for static methods
    const foundDec = TransformUtil.findAnyDecorator(node, { InjectableFactory: new Set(['@travetto/di']) }, state);
    const decls = node.decorators;

    if (foundDec) { // Constructor
      const declTemp = (node.decorators || []).slice(0);

      let injectArgs: object[] = [];

      try {
        injectArgs = node.parameters.map(x => processDeclaration(state, x)!);
      } catch (e) {
        // If error, skip
        if (e.message !== 'Type information not found') {
          throw e;
        }
      }

      if (injectArgs.length) {
        const foundExpr = (foundDec.expression as ts.CallExpression);

        const args = TransformUtil.extendObjectLiteral({
          dependencies: injectArgs
        }, foundExpr.arguments[0] as ts.ObjectLiteralExpression);

        node = ts.createMethod(
          decls!.filter(x => x !== foundDec).concat([
            ts.createDecorator(
              ts.createCall(
                foundExpr.expression,
                foundExpr.typeArguments,
                ts.createNodeArray([args])
              )
            )
          ]),
          node.modifiers,
          node.asteriskToken,
          node.name,
          node.questionToken,
          node.typeParameters,
          node.parameters,
          node.type,
          node.body
        ) as any;
      }

      return node;
    } else {
      return node;
    }
  }
  return ts.visitEachChild(node, c => visitNode(context, c, state), context);
}

export const InjectableTransformer = {
  transformer: TransformUtil.importingVisitor<DiState>(() => ({
    inInjectable: false,
    decorators: {}
  }), visitNode),
  phase: 'before'
}