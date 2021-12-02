import * as cdk from '@aws-cdk/core';
import * as eks from '@aws-cdk/aws-eks';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import * as kms from '@aws-cdk/aws-kms';
import * as rds from '@aws-cdk/aws-rds';
import * as efs from '@aws-cdk/aws-efs';
import * as elasticache from '@aws-cdk/aws-elasticache';
import * as secretsmanager from '@aws-cdk/aws-secretsmanager';

export interface EksMoodleStackProps extends cdk.StackProps {

  // The ARN of AWS IAM User to be added as cluster admin. This is used for seamless eksctl compatibility.
  // Use your current AWS CLI user.
  EksMasterAwsCliUserArn: string;
}

export class EksMoodleStack extends cdk.Stack {

  // Local variables
  private readonly MoodleDatabaseName = 'moodledb';
  private readonly MoodleDatabaseUsername = 'dbadmin';
  private readonly RdsInstanceType = 'r5.large';
  private readonly ElasticacheRedisInstanceType = 'cache.r6g.large';

  constructor(scope: cdk.App, id: string, props: EksMoodleStackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new ec2.Vpc(this, 'moodle-vpc', {
      maxAzs: 2
    });

    // EKS Cluster
    var secretsKey = new kms.Key(this, 'secretsKey', {})
    const cluster = new eks.Cluster(this, 'eks-cluster', {
      version: eks.KubernetesVersion.V1_21,
      vpc: vpc,
      defaultCapacity: 0,
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      secretsEncryptionKey: secretsKey
    });

    // Add CLI user to system:masters group for seamless eksctl compatibility
    var cliUser = iam.User.fromUserArn(this, 'cli-user', props.EksMasterAwsCliUserArn);
    cluster.awsAuth.addUserMapping(cliUser, { groups: [ 'system:masters' ] });

    const ondemandLargeNodeGroup = cluster.addNodegroupCapacity('ondemand-mlarge-node-group', {
      instanceTypes: [new ec2.InstanceType('m5.large')],
      minSize: 2,
      desiredSize: 2,
      maxSize: 10,
      diskSize: 50
    });
    ondemandLargeNodeGroup.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    const spotLargeNodeGroup = cluster.addNodegroupCapacity('spot-mlarge-node-group', {
      capacityType: eks.CapacityType.SPOT,
      instanceTypes: [new ec2.InstanceType('m5.large'), new ec2.InstanceType('m5a.large'), new ec2.InstanceType('m4.large')],
      minSize: 2,
      desiredSize: 2,
      maxSize: 10,
      diskSize: 50
    });
    spotLargeNodeGroup.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    const spotXLargeNodeGroup = cluster.addNodegroupCapacity('spot-mxlarge-node-group', {
      capacityType: eks.CapacityType.SPOT,
      instanceTypes: [new ec2.InstanceType('m5.xlarge'), new ec2.InstanceType('m5a.xlarge'), new ec2.InstanceType('m4.xlarge')],
      minSize: 0,
      desiredSize: 0,
      maxSize: 5,
      diskSize: 50
    });
    spotXLargeNodeGroup.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    // RDS
    const moodleDb = new rds.DatabaseInstance(this, 'moodle-db', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_5_7_34}),
      vpc: vpc,
      vpcSubnets: { 
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT
      },
      instanceType: new ec2.InstanceType(this.RdsInstanceType),
      allocatedStorage: 30,
      maxAllocatedStorage: 300,
      storageType: rds.StorageType.GP2,
      autoMinorVersionUpgrade: true,
      multiAz: true,
      databaseName: this.MoodleDatabaseName,
      credentials: rds.Credentials.fromGeneratedSecret(this.MoodleDatabaseUsername, { excludeCharacters: '(" %+~`#$&*()|[]{}:;<>?!\'/^-,@_=\\' }), // Punctuations are causing issue with Moodle connecting to the database
      enablePerformanceInsights: true
    });
    moodleDb.connections.allowDefaultPortFrom(cluster, 'From EKS Cluster');

    // EFS
    const moodleEfs = new efs.FileSystem(this, 'moodle-efs', {
      vpc: vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enableAutomaticBackups: true
    });
    moodleEfs.connections.allowDefaultPortFrom(cluster, 'From EKS Cluster');

    // ElastiCache Redis
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'redis-subnet-group', {
      cacheSubnetGroupName: 'eks-moodle-redis-private-subnet-group',
      description: 'EKS Moodle Redis Subnet Group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_NAT }).subnetIds
    });

    const redisSG = new ec2.SecurityGroup(this, 'moodle-redis-sg', {
      vpc: vpc
    });

    const moodleRedis = new elasticache.CfnReplicationGroup(this, 'moodle-redis', {
      replicationGroupDescription: 'Moodle Redis',
      cacheNodeType: this.ElasticacheRedisInstanceType,
      engine: 'redis',
      numCacheClusters: 2,
      multiAzEnabled: true,
      automaticFailoverEnabled: true,
      autoMinorVersionUpgrade: true,
      cacheSubnetGroupName: 'eks-moodle-redis-private-subnet-group',
      securityGroupIds: [ redisSG.securityGroupId ],
    });
    moodleRedis.addDependsOn(redisSubnetGroup);
    redisSG.connections.allowFrom(cluster, ec2.Port.tcp(6379), 'From EKS Cluster');

    // Outputs
    new cdk.CfnOutput(this, 'MOODLE-DATABASE-HOST', {
      value: moodleDb.dbInstanceEndpointAddress
    });
    new cdk.CfnOutput(this, 'MOODLE-DATABASE-PORT-NUMBER', {
      value: moodleDb.dbInstanceEndpointPort
    });
    new cdk.CfnOutput(this, 'MOODLE-DATABASE-NAME', {
      value: this.MoodleDatabaseName
    });
    new cdk.CfnOutput(this, 'MOODLE-DATABASE-USER', {
      value: this.MoodleDatabaseUsername
    });
    new cdk.CfnOutput(this, 'MOODLE-DATABASE-CREDENTIAL-SECRET-ARN', {
      value: moodleDb.secret!.secretArn
    });
    new cdk.CfnOutput(this, 'MOODLE-EFS-ID', {
      value: moodleEfs.fileSystemId
    });
    new cdk.CfnOutput(this, 'MOODLE-REDIS-PRIMARY-ENDPOINT-ADDRESS-AND-PORT', {
      value: `${moodleRedis.attrPrimaryEndPointAddress}:${moodleRedis.attrPrimaryEndPointPort}`
    });
    new cdk.CfnOutput(this, 'MOODLE-EKS-CLUSTER-NAME', {
      value: cluster.clusterName
    });
  }
}
