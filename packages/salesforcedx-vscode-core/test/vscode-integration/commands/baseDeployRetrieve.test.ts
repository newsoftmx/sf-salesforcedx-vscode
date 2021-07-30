/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { AuthInfo, Connection } from '@salesforce/core';
import { MockTestOrgData, testSetup } from '@salesforce/core/lib/testSetup';
import { ConfigUtil } from '@salesforce/salesforcedx-utils-vscode/out/src';
import { Table } from '@salesforce/salesforcedx-utils-vscode/out/src/output';
import { ContinueResponse } from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import {
  ComponentSet,
  ComponentStatus,
  DeployResult,
  FileProperties,
  MetadataApiDeploy,
  MetadataApiRetrieve,
  MetadataApiRetrieveStatus,
  registry,
  RetrieveResult,
  SourceComponent
} from '@salesforce/source-deploy-retrieve';
import {
  MetadataApiDeployStatus,
  RequestStatus
} from '@salesforce/source-deploy-retrieve/lib/src/client/types';
import { fail } from 'assert';
import { expect } from 'chai';
import { Test } from 'mocha';
import { basename, dirname, join, sep } from 'path';
import { createSandbox, SinonSpy, SinonStub, spy } from 'sinon';
import * as vscode from 'vscode';
import { channelService } from '../../../src/channels';
import { BaseDeployExecutor } from '../../../src/commands';
import {
  DeployExecutor,
  DeployRetrieveExecutor,
  RetrieveExecutor
} from '../../../src/commands/baseDeployRetrieve';
import { PersistentStorageService } from '../../../src/conflict/persistentStorageService';
import { workspaceContext } from '../../../src/context';
import { nls } from '../../../src/messages';
import { DeployQueue } from '../../../src/settings';
import { SfdxPackageDirectories } from '../../../src/sfdxProject';
import { getRootWorkspacePath } from '../../../src/util';
import {
  decomposed,
  matchingContentFile,
  mockRegistry
} from '../mock/registry';
import { MockContext } from '../telemetry/MockContext';

const sb = createSandbox();
const $$ = testSetup();

type DeployRetrieveOperation = MetadataApiDeploy | MetadataApiRetrieve;

describe('Base Deploy Retrieve Commands', () => {
  let mockConnection: Connection;

  beforeEach(async () => {
    const testData = new MockTestOrgData();
    $$.setConfigStubContents('AuthInfoConfig', {
      contents: await testData.getConfig()
    });
    mockConnection = await Connection.create({
      authInfo: await AuthInfo.create({
        username: testData.username
      })
    });
    sb.stub(workspaceContext, 'getConnection').resolves(mockConnection);
  });

  afterEach(() => sb.restore());

  describe('DeployRetrieveCommand', () => {
    class TestDeployRetrieve extends DeployRetrieveExecutor<{}> {
      public lifecycle = {
        getComponentsStub: sb.stub().returns(new ComponentSet()),
        doOperationStub: sb.stub(),
        postOperationStub: sb.stub()
      };

      constructor() {
        super('test', 'testlog');
      }

      protected getComponents(
        response: ContinueResponse<{}>
      ): Promise<ComponentSet> {
        return this.lifecycle.getComponentsStub();
      }
      protected doOperation(components: ComponentSet): Promise<undefined> {
        return this.lifecycle.doOperationStub(components);
      }
      protected postOperation(result: undefined): Promise<void> {
        return this.lifecycle.postOperationStub(result);
      }
    }

    it('should call lifecycle methods in correct order', async () => {
      const executor = new TestDeployRetrieve();
      const {
        doOperationStub,
        getComponentsStub,
        postOperationStub
      } = executor.lifecycle;

      await executor.run({ data: {}, type: 'CONTINUE' });

      expect(getComponentsStub.calledOnce).to.equal(true);
      expect(doOperationStub.calledAfter(getComponentsStub)).to.equal(true);
      expect(postOperationStub.calledAfter(doOperationStub)).to.equal(true);
    });

    it('should add component count to telemetry data', async () => {
      const executor = new TestDeployRetrieve();
      const components = new ComponentSet([
        { fullName: 'MyClass', type: 'ApexClass' },
        { fullName: 'MyClass2', type: 'ApexClass' },
        { fullName: 'MyLayout', type: 'Layout' }
      ]);
      executor.lifecycle.getComponentsStub.returns(components);

      await executor.run({ data: {}, type: 'CONTINUE' });

      const { properties } = executor.telemetryData;
      expect(properties).to.not.equal(undefined);

      const { metadataCount } = properties!;
      expect(metadataCount).to.not.equal(undefined);

      const componentCount = JSON.parse(metadataCount);
      expect(componentCount).to.deep.equal([
        { type: 'ApexClass', quantity: 2 },
        { type: 'Layout', quantity: 1 }
      ]);
    });

    it('should return success when operation status is "Succeeded"', async () => {
      const executor = new TestDeployRetrieve();
      executor.lifecycle.doOperationStub.resolves({
        response: { status: RequestStatus.Succeeded }
      });

      const success = await executor.run({ data: {}, type: 'CONTINUE' });

      expect(success).to.equal(true);
    });

    it('should return success when operation status is "SucceededPartial"', async () => {
      const executor = new TestDeployRetrieve();
      executor.lifecycle.doOperationStub.resolves({
        response: { status: RequestStatus.SucceededPartial }
      });

      const success = await executor.run({ data: {}, type: 'CONTINUE' });

      expect(success).to.equal(true);
    });

    it('should return unsuccessful when operation status is "Failed"', async () => {
      const executor = new TestDeployRetrieve();
      executor.lifecycle.doOperationStub.resolves({
        response: { status: RequestStatus.Failed }
      });

      const success = await executor.run({ data: {}, type: 'CONTINUE' });

      expect(success).to.equal(false);
    });

    it('should format error with project path', async () => {
      const executor = new TestDeployRetrieve();
      const projectPath = join(
        'force-app',
        'main',
        'default',
        'classes',
        'someclass.xyz'
      );
      const fullPath = join(getRootWorkspacePath(), projectPath);
      const error = new Error(`Problem with ${fullPath}`);
      executor.lifecycle.getComponentsStub.throws(error);

      try {
        await executor.run({ data: {}, type: 'CONTINUE' });
        fail('should have thrown an error');
      } catch (e) {
        expect(e.message).to.equal(`Problem with ${sep}${projectPath}`);
      }
    });

    it('should use the api version from SFDX configuration', async () => {
      const executor = new TestDeployRetrieve();
      const configApiVersion = '30.0';
      sb.stub(ConfigUtil, 'getConfigValue')
        .withArgs('apiVersion')
        .returns(configApiVersion);

      await executor.run({ data: {}, type: 'CONTINUE' });
      const components = executor.lifecycle.doOperationStub.firstCall.args[0];

      expect(components.apiVersion).to.equal(configApiVersion);
    });

    it('should not override api version if getComponents set it already', async () => {
      const executor = new TestDeployRetrieve();

      const getComponentsResult = new ComponentSet();
      getComponentsResult.apiVersion = '41.0';
      executor.lifecycle.getComponentsStub.returns(getComponentsResult);

      const configApiVersion = '45.0';
      sb.stub(ConfigUtil, 'getConfigValue')
        .withArgs('apiVersion')
        .returns(configApiVersion);

      await executor.run({ data: {}, type: 'CONTINUE' });
      const components = executor.lifecycle.doOperationStub.firstCall.args[0];

      expect(components.apiVersion).to.equal(getComponentsResult.apiVersion);
    });

    it('should use the registry api version by default', async () => {
      const executor = new TestDeployRetrieve();
      const registryApiVersion = registry.apiVersion;
      sb.stub(ConfigUtil, 'getConfigValue')
        .withArgs('apiVersion')
        .returns(undefined);

      await executor.run({ data: {}, type: 'CONTINUE' });
      const components = executor.lifecycle.doOperationStub.firstCall.args[0];

      expect(components.apiVersion).to.equal(registryApiVersion);
    });
  });

  describe('DeployExecutor', () => {
    let deployQueueStub: SinonStub;

    const packageDir = 'test-app';

    beforeEach(async () => {
      sb.stub(SfdxPackageDirectories, 'getPackageDirectoryPaths').resolves([
        packageDir
      ]);

      deployQueueStub = sb.stub(DeployQueue.prototype, 'unlock');
      const mockContext = new MockContext(false);
      PersistentStorageService.initialize(mockContext);
    });

    class TestDeploy extends DeployExecutor<{}> {
      public components: ComponentSet;
      public getComponentsStub = sb.stub().returns(new ComponentSet());
      public startStub: SinonStub;
      public deployStub: SinonStub;
      public cancellationStub = sb.stub();
      public cacheSpy: SinonSpy;

      constructor(toDeploy = new ComponentSet()) {
        super('test', 'testlog');
        this.components = toDeploy;
        this.startStub = sb.stub();
        this.deployStub = sb
          .stub(this.components, 'deploy')
          .returns({ start: this.startStub });
        this.cacheSpy = sb.spy(PersistentStorageService.getInstance(), 'setPropertiesForFilesDeploy');
      }

      protected async getComponents(
        response: ContinueResponse<{}>
      ): Promise<ComponentSet> {
        return this.components;
      }
      protected async setupCancellation(
        operation: DeployRetrieveOperation | undefined,
        token?: vscode.CancellationToken
      ) {
        return this.cancellationStub;
      }
    }

    it('should call setup cancellation logic', async () => {
      const executor = new TestDeploy();
      const operationSpy = spy(executor, 'setupCancellation' as any);

      await executor.run({ data: {}, type: 'CONTINUE' });

      expect(operationSpy.calledOnce).to.equal(true);
    });

    it('should call deploy on component set', async () => {
      const executor = new TestDeploy();

      await executor.run({ data: {}, type: 'CONTINUE' });

      expect(executor.deployStub.calledOnce).to.equal(true);
      expect(executor.deployStub.firstCall.args[0]).to.deep.equal({
        usernameOrConnection: mockConnection
      });
      expect(executor.startStub.calledOnce).to.equal(true);
    });

    it('should store properties in metadata cache on successful deploy', async () => {
      const executor = new TestDeploy();
      const deployComponentOne = matchingContentFile.COMPONENT;
      const deployComponentTwo = decomposed.DECOMPOSED_COMPONENT;
      const mockDeployResult = new DeployResult(
        {
          status: RequestStatus.Succeeded,
          lastModifiedDate: 'Yesterday'
        } as MetadataApiDeployStatus,
        new ComponentSet([
          deployComponentOne,
          deployComponentTwo
        ], mockRegistry)
      );
      const fileResponses: any[] = [];
      const cache = PersistentStorageService.getInstance();
      sb.stub(mockDeployResult, 'getFileResponses').returns(fileResponses);
      executor.startStub.resolves(mockDeployResult);

      await executor.run({data: {}, type: 'CONTINUE' });

      expect(executor.cacheSpy.callCount).to.equal(1);
      expect(executor.cacheSpy.args[0][0].components.size).to.equal(2);
      expect(cache.getPropertiesForFile(
        cache.makeKey(deployComponentOne.type.name, deployComponentOne.name)
        )?.lastModifiedDate).to.equal('Yesterday');
      expect(cache.getPropertiesForFile(
        cache.makeKey(deployComponentTwo.type.name, deployComponentTwo.name)
        )?.lastModifiedDate).to.equal('Yesterday');
    });

    it('should not store any properties in metadata cache on failed deploy', async () => {
      const executor = new TestDeploy();
      const mockDeployResult = new DeployResult(
        {
          status: RequestStatus.Failed
        } as MetadataApiDeployStatus,
        new ComponentSet()
      );
      const fileResponses: any[] = [];
      sb.stub(mockDeployResult, 'getFileResponses').returns(fileResponses);
      executor.startStub.resolves(mockDeployResult);
      const success = await executor.run({ data: {}, type: 'CONTINUE' });

      expect(success).to.equal(false);
      expect(executor.cacheSpy.callCount).to.equal(1);
      expect(executor.cacheSpy.args[0][0].components.size).to.equal(0);
    });

    describe('Result Output', () => {
      let appendLineStub: SinonStub;

      const fileResponses: any[] = [
        {
          fullName: 'MyClass',
          type: 'ApexClass',
          state: ComponentStatus.Changed,
          filePath: join('project', packageDir, 'MyClass.cls')
        },
        {
          fullName: 'MyClass',
          type: 'ApexClass',
          state: ComponentStatus.Changed,
          filePath: join('project', packageDir, 'MyClass.cls-meta.xml')
        },
        {
          fullName: 'MyLayout',
          type: 'Layout',
          state: ComponentStatus.Created,
          filePath: join('project', packageDir, 'MyLayout.layout-meta.xml')
        }
      ];

      beforeEach(() => {
        appendLineStub = sb.stub(channelService, 'appendLine');
      });

      it('should output table of deployed components if successful', async () => {
        const executor = new TestDeploy();

        const mockDeployResult = new DeployResult(
          {
            status: RequestStatus.Succeeded
          } as MetadataApiDeployStatus,
          new ComponentSet()
        );
        sb.stub(mockDeployResult, 'getFileResponses').returns(fileResponses);
        executor.startStub.resolves(mockDeployResult);

        const formattedRows = fileResponses.map(r => ({
          fullName: r.fullName,
          type: r.type,
          state: r.state,
          filePath: r.filePath.replace(`project${sep}`, '')
        }));
        const expectedOutput = new Table().createTable(
          formattedRows,
          [
            { key: 'state', label: nls.localize('table_header_state') },
            { key: 'fullName', label: nls.localize('table_header_full_name') },
            { key: 'type', label: nls.localize('table_header_type') },
            {
              key: 'filePath',
              label: nls.localize('table_header_project_path')
            }
          ],
          nls.localize(`table_title_deployed_source`)
        );

        await executor.run({ data: {}, type: 'CONTINUE' });

        expect(appendLineStub.calledOnce).to.equal(true);
        expect(appendLineStub.firstCall.args[0]).to.equal(expectedOutput);
      });

      it('should output table of failed components if unsuccessful', async () => {
        const executor = new TestDeploy();

        const mockDeployResult = new DeployResult(
          {
            status: RequestStatus.Failed
          } as MetadataApiDeployStatus,
          new ComponentSet()
        );
        executor.startStub.resolves(mockDeployResult);

        const failedRows = fileResponses.map(r => ({
          fullName: r.fullName,
          type: r.type,
          error: 'There was an issue',
          filePath: r.filePath
        }));
        sb.stub(mockDeployResult, 'getFileResponses').returns(failedRows);

        const formattedRows = fileResponses.map(r => ({
          fullName: r.fullName,
          type: r.type,
          error: 'There was an issue',
          filePath: r.filePath.replace(`project${sep}`, '')
        }));
        const expectedOutput = new Table().createTable(
          formattedRows,
          [
            {
              key: 'filePath',
              label: nls.localize('table_header_project_path')
            },
            { key: 'error', label: nls.localize('table_header_errors') }
          ],
          nls.localize(`table_title_deploy_errors`)
        );

        await executor.run({ data: {}, type: 'CONTINUE' });

        expect(appendLineStub.calledOnce).to.equal(true);
        expect(appendLineStub.firstCall.args[0]).to.equal(expectedOutput);
      });

      it('should report any diagnostics if deploy failed', async () => {
        const executor = new TestDeploy();

        const mockDeployResult = new DeployResult(
          {
            status: RequestStatus.Failed
          } as MetadataApiDeployStatus,
          new ComponentSet()
        );
        executor.startStub.resolves(mockDeployResult);

        const failedRows = fileResponses.map(r => ({
          fullName: r.fullName,
          type: r.type,
          error: 'There was an issue',
          state: ComponentStatus.Failed,
          filePath: r.filePath,
          problemType: 'Error',
          lineNumber: 2,
          columnNumber: 3
        }));
        sb.stub(mockDeployResult, 'getFileResponses').returns(failedRows);

        const setDiagnosticsStub = sb.stub(
          BaseDeployExecutor.errorCollection,
          'set'
        );

        await executor.run({ data: {}, type: 'CONTINUE' });

        expect(setDiagnosticsStub.callCount).to.equal(failedRows.length);
        failedRows.forEach((row, index) => {
          expect(setDiagnosticsStub.getCall(index).args).to.deep.equal([
            vscode.Uri.file(row.filePath),
            [
              {
                message: row.error,
                range: new vscode.Range(
                  row.lineNumber - 1,
                  row.columnNumber - 1,
                  row.lineNumber - 1,
                  row.columnNumber - 1
                ),
                severity: vscode.DiagnosticSeverity.Error,
                source: row.type
              }
            ]
          ]);
        });
      });
    });

    it('should unlock the deploy queue when finished', async () => {
      const executor = new TestDeploy();

      await executor.run({ data: {}, type: 'CONTINUE' });

      expect(deployQueueStub.calledOnce).to.equal(true);
    });
  });

  describe('RetrieveExecutor', () => {
    const packageDir = 'test-app';

    class TestRetrieve extends RetrieveExecutor<{}> {
      public components: ComponentSet;
      public startStub: SinonStub;
      public retrieveStub: SinonStub;
      public cacheSpy: SinonSpy;

      constructor(toRetrieve = new ComponentSet()) {
        super('test', 'testlog');
        this.components = toRetrieve;
        this.startStub = sb.stub();
        this.retrieveStub = sb
          .stub(this.components, 'retrieve')
          .returns({ start: this.startStub });
        this.cacheSpy = sb.spy(PersistentStorageService.getInstance(), 'setPropertiesForFilesRetrieve');
      }

      protected async getComponents(
        response: ContinueResponse<{}>
      ): Promise<ComponentSet> {
        return this.components;
      }
    }

    beforeEach(() => {
      sb.stub(SfdxPackageDirectories, 'getPackageDirectoryPaths').resolves([
        packageDir
      ]);
      const mockContext = new MockContext(false);
      PersistentStorageService.initialize(mockContext);
    });

    it('should call retrieve on component set', async () => {
      const components = new ComponentSet(matchingContentFile.COMPONENTS, mockRegistry);
      const executor = new TestRetrieve(components);

      await executor.run({ data: {}, type: 'CONTINUE' });

      expect(executor.retrieveStub.callCount).to.equal(1);
    });

    it('should call setup cancellation logic', async () => {
      const executor = new TestRetrieve();
      const operationSpy = spy(executor, 'setupCancellation' as any);

      await executor.run({ data: {}, type: 'CONTINUE' });

      expect(operationSpy.calledOnce).to.equal(true);
    });

    it('should store properties in metadata cache on successful retrieve', async () => {
      const executor = new TestRetrieve();
      const mockRetrieveResult = new RetrieveResult(
        {
          status: RequestStatus.Succeeded,
          fileProperties: [
            {fullName: 'one', type: 'ApexClass', lastModifiedDate: 'Today'},
            {fullName: 'two', type: 'CustomObject', lastModifiedDate: 'Yesterday'}
          ]
        } as MetadataApiRetrieveStatus,
        new ComponentSet()
      );
      const cache = PersistentStorageService.getInstance();
      executor.startStub.resolves(mockRetrieveResult);

      await executor.run({data: {}, type: 'CONTINUE' });

      expect(executor.cacheSpy.callCount).to.equal(1);
      expect(executor.cacheSpy.args[0][0].length).to.equal(2);
      expect(cache.getPropertiesForFile(cache.makeKey('ApexClass', 'one'))?.lastModifiedDate).to.equal('Today');
      expect(cache.getPropertiesForFile(cache.makeKey('CustomObject', 'two'))?.lastModifiedDate).to.equal('Yesterday');
    });

    it('should not store any properties in metadata cache on failed retrieve', async () => {
      const executor = new TestRetrieve();
      const mockRetrieveResult = new RetrieveResult(
        {
          status: RequestStatus.Failed,
          fileProperties: [] as FileProperties[]
        } as MetadataApiRetrieveStatus,
        new ComponentSet()
      );
      executor.startStub.resolves(mockRetrieveResult);

      await executor.run({data: {}, type: 'CONTINUE' });

      expect(executor.cacheSpy.callCount).to.equal(1);
      expect(executor.cacheSpy.args[0][0].length).to.equal(0);
    });

    describe('Result Output', () => {
      let appendLineStub: SinonStub;

      beforeEach(() => {
        appendLineStub = sb.stub(channelService, 'appendLine');
      });

      it('should output table of components for successful retrieve', async () => {
        const executor = new TestRetrieve();
        const mockRetrieveResult = new RetrieveResult(
          {
            status: RequestStatus.Succeeded,
            fileProperties: [] as FileProperties[]
          } as MetadataApiRetrieveStatus,
          new ComponentSet()
        );
        executor.startStub.resolves(mockRetrieveResult);

        const fileResponses = [
          {
            fullName: 'MyClass',
            type: 'ApexClass',
            filePath: join('project', packageDir, 'MyClass.cls')
          },
          {
            fullName: 'MyClass',
            type: 'ApexClass',
            filePath: join('project', packageDir, 'MyClass.cls')
          },
          {
            fullName: 'MyLayout',
            type: 'Layout',
            filePath: join('project', packageDir, 'MyLayout.layout-meta.xml')
          }
        ];
        sb.stub(mockRetrieveResult, 'getFileResponses').returns(fileResponses);

        const formattedRows = fileResponses.map(r => ({
          fullName: r.fullName,
          type: r.type,
          filePath: r.filePath.replace(`project${sep}`, '')
        }));
        const expectedOutput = new Table().createTable(
          formattedRows,
          [
            { key: 'fullName', label: nls.localize('table_header_full_name') },
            { key: 'type', label: nls.localize('table_header_type') },
            {
              key: 'filePath',
              label: nls.localize('table_header_project_path')
            }
          ],
          nls.localize(`lib_retrieve_result_title`)
        );

        await executor.run({ data: {}, type: 'CONTINUE' });

        expect(appendLineStub.calledOnce).to.equal(true);
        expect(appendLineStub.firstCall.args[0]).to.equal(expectedOutput);
      });

      it('should output table of components for failed retrieve', async () => {
        const executor = new TestRetrieve();
        const mockRetrieveResult = new RetrieveResult(
          {
            status: RequestStatus.Failed,
            fileProperties: [] as FileProperties[]
          } as MetadataApiRetrieveStatus,
          new ComponentSet()
        );
        executor.startStub.resolves(mockRetrieveResult);

        const fileResponses = [
          {
            fullName: 'MyClass',
            type: 'ApexClass',
            state: ComponentStatus.Failed,
            error: 'There was problem with this component',
            problemType: 'Error'
          },
          {
            fullName: 'MyClass',
            type: 'ApexClass',
            state: ComponentStatus.Failed,
            error: 'There was problem with this component',
            problemType: 'Error'
          }
        ];
        sb.stub(mockRetrieveResult, 'getFileResponses').returns(fileResponses);

        const formattedRows = fileResponses.map(r => ({
          fullName: r.fullName,
          type: r.type,
          error: r.error
        }));
        const expectedOutput = new Table().createTable(
          formattedRows,
          [
            { key: 'fullName', label: nls.localize('table_header_full_name') },
            { key: 'type', label: nls.localize('table_header_type') },
            {
              key: 'error',
              label: nls.localize('table_header_message')
            }
          ],
          nls.localize('lib_retrieve_message_title')
        );

        await executor.run({ data: {}, type: 'CONTINUE' });

        expect(appendLineStub.calledOnce).to.equal(true);
        expect(appendLineStub.firstCall.args[0]).to.equal(expectedOutput);
      });
    });
  });
});
