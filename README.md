# Scalable Moodle LMS on Amazon Elastic Kubernetes Service (EKS)

Moodle is a popular open source learning management system. Many education institutions are using Moodle to provides an online learning platform for their students to achieve their learning goals. It is especially critical due to the impact of Covid-19 to the face-to-face learning process.

## Before you begin
Amazon ECS allows you to implement Moodle LMS using containers in a more simplified way. Please look at the sample here https://github.com/hendryaw/cdk-ecs-moodle

## Overview

This sample deployment allows you to run Moodle LMS using Kubernetes on Amazon EKS in a scalable and cost-efficient way by using Amazon EC2 Spot. While using EC2 Spot, the sample will also include considerations to make the deployment more fault-tolerant.

This deployment guide consists of 3 parts that makes the whole deployment. In the future the sample deployment might be simplified through CDK8s and built-in controller addons. These are the 3 parts:
1. CDK Application to deploy the underlying infrastructure such as Amazon EKS Cluster, RDS, ElastiCache, and Elastic File System.
2. Installation of drivers and controllers
3. Installation of Moodle application using K8S manifests through Helm.

The following is the high-level architecture diagram.

![Moodle on EKS Architecture](/docs/images/moodle-on-eks.jpg "Moodle on EKS Architecture")

The infrastructure is designed with high-availability using 2 Availability Zones with the following components:
- Moodle containerized application is based on [Bitnami Moodle Docker image](https://github.com/bitnami/bitnami-docker-moodle) with some modification to enable Redis caching store.
- Amazon EC2 On-Demand instances is being used along with Amazon EC2 Spot for K8S Worker Nodes to provide a scalable and cost-efficient way to run Moodle application
- Amazon Elastic File System (EFS) is deployed to be mounted on the container to be used as `moodledata` filesystem
- Moodle database is deployed using Amazon Relational Database Service (RDS)
- To improve performance, ElastiCache Redis is deployed to be used on Moodle caching configuration
- Application endpoint is being exposed using a public Application Load Balancer (ALB) through ALB Ingress secured with TLS encryption with the certificate stored in AWS Certificate Manager
- AWS Secrets Manager is being used during CDK deployment to securely store sensitive data such as database password

While using Amazon EC2 Spot, it is important to design the application environment to be more fault-tolerant. The following are some considerations that can be applied in this deployment:
1. Use multiple Availability Zones for larger Spot capacity pools. Use multiple instance types with similar capacity within the same node group e.g. m5.large with m5a.large and m4.large.
2. Use Horizontal Pod Autoscaler (HPA) to scale the pods and Cluster Autoscaler to scale the nodes.
3. Configure Cluster Autoscaler expander to prioritize Spot instances during scale out
4. Use AWS Node Termination Handler to handle Spot interruption notice
5. Use `NodeSelector` or `NodeAffinity` to place critical / stateful services to on-demand node group that is less interruptable
6. Use `PodAntiAffinity` to spread the application pods across AZ, instance types, and hosts.

## Prerequisites
You will need a public domain name in order to request a public certificate in AWS ACM. If you don't have a public domain name yet, consider using Amazon Route 53 to register a new domain: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html

## 1. Deploying the CDK Application
The following are the steps to deploy the CDK application:
1. If this is the first time you are using CDK then do the following:
    - Configure AWS CLI if you haven't
    - Install CDK using `npm install -g aws-cdk`
    - Run `cdk bootstrap`
2. Get your current AWS CLI User ARN by running `aws sts get-caller-identity`, and replace the `EksMasterAwsCliUserArn` property specified in the `src/cdk/bin/cdk.ts`
2. Run `cdk deploy` to deploy this solution.
3. Connect to the EKS cluster by using `aws eks update-kubeconfig --name <cluster_name> --region <region>`

## 2. Installing Required K8S Drivers and Controllers
### Enable IAM Roles for Service Accounts (IRSA)
IRSA will be used to implement least-privilege security practice by giving individual IAM permissions for the pods instead of nodes https://docs.aws.amazon.com/eks/latest/userguide/enable-iam-roles-for-service-accounts.html

### Deploy Load Balancer Controller
The load balancer controller will handle the k8s resources that requires AWS Load Balancer such as Service with type of LoadBalancer and ALB Ingress 
https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html

### Deploy EFS CSI Driver
The EFS CSI Driver will handle the EFS volume mount to the pods https://docs.aws.amazon.com/eks/latest/userguide/efs-csi.html

### Deploy EKS Spot Node Termination Handler
The EKS Spot Node Termination Handler will help in intercepting the Spot interruption notice and drain the interrupted Spot instance https://github.com/aws/aws-node-termination-handler

### Enable Auto Scaling Components
- Deploy Metric Server to allow Horizontal Pod Autoscaler to scale based on the metrics collected such as CPU https://docs.aws.amazon.com/eks/latest/userguide/metrics-server.html
- Deploy Cluster AutoScaler to allow k8s to scale the number of worker nodes https://docs.aws.amazon.com/eks/latest/userguide/cluster-autoscaler.html
- Set Cluster AutoScaler to run on ONDEMAND node. This will protect the Cluster Autoscaler from being killed because of Spot interruptions.

    Add the nodeSelector in the deployment `spec.template.spec`
    ```
    nodeSelector:
      eks.amazonaws.com/capacityType: ON_DEMAND
    ```

- Configure Cluster Autoscaler Expander Priority to allow Cluster Autoscaler to prioritize Spot instance type during scale out.
    - Create the ConfigMap based on `src/k8s/cluster-autoscaler-priority-expander-config.yaml`. The ConfigMap prioritize the large spot, xlarge spot, and then any instance type including on-demand in order. 
    - Then set the flag `--expander=priority` on deployment container's arguments on `spec.template.spec.containers[0].command`.

## 3. Install the Moodle Application
### Secrets
First you'll need to create K8s secrets to be used in our deployment. You can fetch the Moodle Database Password from AWS Secrets Manager based on the ARN in the CDK or CloudFormation outputs.
```
  kubectl create secret generic moodle-with-efs-secrets --namespace default --from-literal=moodle-db-password=<INSERT_MOODLE_DB_PASSWORD> --from-literal=moodle-password=<INSERT_MOODLE_PASSWORD>
```

### ALB TLS Certificate in AWS Certificate Manager
[Request a public certificate](https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-request-public.html) for your domain name using AWS Certificate Manager (ACM). Note the certificate ARN to be used in the next step.

### Moodle Helm Chart Installation
- You'll need to modify the configuration values in the `src/k8s/moodle-with-efs/values.yaml`. You can refer to the CDK or CloudFormation outputs.
- Then run:

    ```
    helm install <NAME> src/k8s/moodle-with-efs --namespace default
    ```
- Once successfully deployed, Moodle will begin first-time installation and it will take approximately 15 - 20 minutes. You can check the progress by checking at the logs of the pod.
- Once it is completed, you can access the application endpoint on the ALB endpoint. Use `kubectl get ingress --namespace default -o wide` to check the ingress endpoints.
- (Optional) You can configure a domain record for the ALB endpoint to clear the SSL warning.
- Finally, to improve Moodle application performance, configure Moodle caching using the ElastiCache Redis endpoint described in the `MOODLEREDISPRIMARYENDPOINTADDRESSANDPORT` output.
    - Add the cache store instance using the ElastiCache Redis endpoint. Refer to the following documentation: [Adding cache store instances](https://docs.moodle.org/311/en/Caching#Adding_cache_store_instances)
    - Set the `Application` cache to use the Redis cache store instance added previously. Refer to the following documentation: [Setting the stores that get used when no mapping is present](https://docs.moodle.org/311/en/Caching#Setting_the_stores_that_get_used_when_no_mapping_is_present)
- (Optional) You can also scale the number of minimum replicas in the HPA if desired.

## Teardown
You should consider deleting the application infrastructure once you no longer need it to save costs. 
- Use `helm uninstall <NAME> --namespace default`
- Use `cdk destroy` to delete the CDK application.

## Next Steps
To improve the application even further, you can explore the following:
- Metrics and logs collection for monitoring using CloudWatch Container Insights and/or Prometheus Grafana stack.
- Improve the security by implementing AWS WAF and other AWS security services.
- Use Amazon S3 bucket for Moodle static contents such as large files or videos.
- Use Amazon CloudFront for static content delivery network and dynamic content acceleration. 