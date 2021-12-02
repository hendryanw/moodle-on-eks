#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import { EksMoodleStack } from '../lib/eks-moodle-stack';

const app = new cdk.App();
new EksMoodleStack(app, 'eks-moodle-stack', {
  EksMasterAwsCliUserArn: 'arn:aws:iam::123456789012:user/johndoe'
});
